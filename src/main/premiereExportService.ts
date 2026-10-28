import { spawn } from 'child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync
} from 'fs'
import { copyFile } from 'fs/promises'
import { isSamePath } from './exportOutputGuard'
import { tmpdir } from 'os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { projectForOutput } from '@shared/trackVisibility'
import { sequenceDurationFrames } from '@shared/sequence/segmentPlan'
import { telopConcatList } from '@shared/telop/layer'
import { buildPremiereXml, type PremiereOverlayClip } from '@shared/export/premiereXml'
import { premiereMarkers, premiereSrt } from '@shared/export/premiereMarkers'
import type { PremiereExportPayload, PremiereExportResult } from '@shared/export/premiereTypes'
import { safeFileBaseName } from '@shared/fileName'
import { materializeTelopLayer } from './telopLayerStage'
import { trackProcess } from './liveProcesses'
import { describeFfmpegExit } from './ffmpegError'

/**
 * Premiere 用 XML(FCP7 xmeml)の書き出し。XML の中身は `@shared/export/premiereXml` が作り、
 * ここはファイルを並べて書く:
 *
 * - `名前.xml` … シーケンス(本編・重ね・音声・マーカー)
 * - `名前.srt` … テロップの文字(シーケンスの時刻)。Premiere の「キャプション」に読み込める
 * - `名前_media/` … アプリの設定フォルダの中のファイル(ノイズ除去後のマイクの音・ナレーション など)を本編で
 *   使っていれば、その写し。XML はこちらを指す(設定フォルダはこの PC だけのキャッシュで、別の PC で開く・
 *   キャッシュを消すとオフラインになるため。Premiere の「プロジェクトマネージャー」で素材を集めるのと同じく、
 *   XML の隣に置いてフォルダごと渡せるようにする)
 * - 見た目どおりのテロップ(選んだときだけ):
 *   - `png`: `名前_telop/telop_000001.png` …(絵が変わる区間ごとの透過 PNG。XML の一番上のトラックに並ぶ)
 *   - `prores`: `名前_telop.mov`(ProRes 4444・透過付きの 1 本。頭から全体に置く)
 *
 * どちらも画面のプロセスが共通レンダラで描いたテロップの層(`TelopLayerPayload`)をそのまま使う。
 */

export type { PremiereExportPayload, PremiereExportResult }

export interface PremiereExportDeps {
  ffmpegPath: string
  onProgress?: (percent: number, stage: string) => void
  signal?: AbortSignal
  /** 素材の音声のチャンネル数を調べる(無ければステレオとして書く) */
  probeChannels?: (filePath: string) => Promise<number | undefined>
  /** 書き出し先の空き容量(バイト)。試験で差し替える */
  freeBytes?: (dir: string) => number
  /** PNG の入れ替え(試験で途中の失敗を起こすために差し替える) */
  swapPngs?: typeof swapInTelopPngs
  /**
   * アプリのキャッシュのフォルダ(設定フォルダ `userData`)。この中のファイルを本編で使っていれば、XML の隣の
   * `名前_media/` へ写して、XML はそちらを指す(無ければ写さない)
   */
  appCacheDirs?: readonly string[]
  /** `名前_media/` の入れ替え(試験で途中の失敗を起こすために差し替える) */
  swapMedia?: typeof swapInTelopPngs
}

/** 透過の PNG を写すとき、何枚ごとに中止を見て進み具合を出すか */
const COPY_BATCH = 32

/**
 * ProRes 4444(透過)の大きさの見積もり(1 画素・1 フレームあたりのバイト)。テロップの出ていない
 * 透明のフレームが大半でも 1 フレームずつ書くので、尺に比例する(実測: 1080p・3 時間で約 12GB =
 * 0.018。余裕を見て 0.025)
 */
const PRORES_BYTES_PER_PIXEL_FRAME = 0.025

/** 並べて書くファイル・フォルダ(XML の名前から決まる) */
export function premiereSidecarPaths(xmlPath: string): {
  srt: string
  telopDir: string
  telopMov: string
  mediaDir: string
} {
  const base = premiereSidecarBase(xmlPath)
  return {
    srt: `${base}.srt`,
    telopDir: `${base}_telop`,
    telopMov: `${base}_telop.mov`,
    mediaDir: `${base}_media`
  }
}

/** 並べて書くもののうち、もうあるもの(上書きしてよいか確かめるのに使う) */
export function existingPremiereSidecars(xmlPath: string): string[] {
  const p = premiereSidecarPaths(xmlPath)
  return [p.srt, p.telopDir, p.telopMov, p.mediaDir].filter((x) => existsSync(x))
}

/** `path` が `dir` の中(`dir` そのものは除く)にあるか */
export function isInsideDir(path: string, dir: string): boolean {
  if (!path || !dir) return false
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** XML の隣へ写す、アプリのキャッシュの中の素材(写す元と、写した先の名前) */
export interface PremiereMediaCopy {
  assetId: string
  from: string
  name: string
}

/**
 * 本編で使う素材のうち、アプリのキャッシュのフォルダの中にあるもの(ノイズ除去後のマイクの音 など)と、
 * `名前_media/` の中での名前。名前は元のファイルの名前(同じ名前が重なれば `-2` などを付ける)
 */
export function premiereMediaCopies(
  assets: readonly { id: string; filePath: string }[],
  usedIds: ReadonlySet<string>,
  cacheDirs: readonly string[]
): PremiereMediaCopy[] {
  const out: PremiereMediaCopy[] = []
  const names = new Set<string>()
  const byPath = new Map<string, string>()
  for (const a of assets) {
    if (!usedIds.has(a.id) || !cacheDirs.some((d) => isInsideDir(a.filePath, d))) continue
    // 同じファイルを指す素材は 1 回だけ写す
    const same = byPath.get(a.filePath)
    if (same) {
      out.push({ assetId: a.id, from: a.filePath, name: same })
      continue
    }
    const file = basename(a.filePath)
    const ext = extname(file)
    const stem = file.slice(0, file.length - ext.length)
    let name = file
    for (let k = 2; names.has(name.toLowerCase()); k++) name = `${stem}-${k}${ext}`
    names.add(name.toLowerCase())
    byPath.set(a.filePath, name)
    out.push({ assetId: a.id, from: a.filePath, name })
  }
  return out
}

const TELOP_PNG = /^telop_\d{6}\.png$/i

/**
 * 今回の PNG(一時フォルダ `stage` の中)を、本来のフォルダ `dir` へ入れ替える。
 * 前回の `telop_*.png` は消さずに隣の退避フォルダへ移してから入れ、途中で失敗したら元に戻す
 * (前は前回の分を先に消してから 1 枚ずつ移していたので、途中で失敗すると前回の分は消え、今回の分は一時フォルダごと
 *  消され、前回の XML が消えた・入れ替わった PNG を指したまま残った)。
 * 返す `commit` で退避した前回の分を消し、`rollback` で元に戻す(SRT の置き換えが失敗したとき)。
 * ほかの名前のファイル・`telop_*.png` という名前のフォルダには触らない。
 */
export function swapInTelopPngs(
  stage: string,
  dir: string,
  move: (from: string, to: string) => void = renameSync,
  /** 前回の分として退避するファイル(既定は `telop_*.png`) */
  owns: (name: string) => boolean = (name) => TELOP_PNG.test(name)
): { commit: () => void; rollback: () => void } {
  mkdirSync(dir, { recursive: true })
  const backup = mkdtempSync(`${dir}.previous-`)
  const movedOld: string[] = []
  const movedNew: string[] = []
  const rollback = (): void => {
    // 戻すのも失敗しうる(ディスクが外れたなど)。できる所まで戻し、戻せなければ退避フォルダは残す(前回の PNG を失わない)
    let restored = true
    for (const name of movedNew.splice(0).reverse()) {
      try {
        renameSync(join(dir, name), join(stage, name))
      } catch {
        restored = false
      }
    }
    for (const name of movedOld.splice(0).reverse()) {
      try {
        renameSync(join(backup, name), join(dir, name))
      } catch {
        restored = false
      }
    }
    if (restored) rmSync(backup, { recursive: true, force: true })
  }
  try {
    for (const name of readdirSync(dir)) {
      if (!owns(name) || lstatSync(join(dir, name)).isDirectory()) continue
      move(join(dir, name), join(backup, name))
      movedOld.push(name)
    }
    for (const name of readdirSync(stage)) {
      move(join(stage, name), join(dir, name))
      movedNew.push(name)
    }
  } catch (e) {
    rollback()
    throw e
  }
  return { commit: () => rmSync(backup, { recursive: true, force: true }), rollback }
}

/**
 * テロップの PNG のフォルダ `dir` を作れるか。同じ名前のファイル(フォルダでない物)があると、XML・SRT を書いた
 * 後で作れずに失敗していた(SRT だけ新しくなる)。書き始める前に止める
 */
function assertDirUsable(dir: string, what: string): void {
  let isDir = true
  try {
    isDir = statSync(dir).isDirectory()
  } catch {
    return // 無ければ作る
  }
  if (!isDir)
    throw new Error(
      `${what}を入れるフォルダ「${basename(dir)}」と同じ名前のファイルがあります。` +
        'XML を別の名前で書き出すか、そのファイルの名前を変えてください'
    )
}

/**
 * テロップの PNG のフォルダの `telop_NNNNNN.png` を、この企画の素材として使っていれば、その名前の一覧
 * (片付けで消すと素材が消えるので、書き出しを止める)。
 * フォルダは文字列だけでなく実体でも比べる(isSamePath): 大文字小文字を区別しない macOS の既定のディスクで綴りの
 * 大小が違う・シンボリックリンクを通した、といった「同じフォルダの別の綴り」の素材を見落として消していた
 */
export function telopPngsUsedAsAssets(
  dir: string,
  assets: readonly {
    filePath: string
    proxyPath?: string
    denoisedFrom?: string
    proxyBeforeDenoise?: string
  }[]
): string[] {
  const out = new Set<string>()
  for (const a of assets)
    for (const p of [a.filePath, a.proxyPath, a.denoisedFrom, a.proxyBeforeDenoise])
      if (p && TELOP_PNG.test(basename(p)) && isSamePath(dirname(p), dir)) out.add(basename(p))
  return [...out]
}

/** 素材のチャンネル数を同時に調べる数(長尺で素材が数百あっても ffprobe を一度に起こさない) */
const PROBE_CONCURRENCY = 4

function defaultFreeBytes(dir: string): number {
  const st = statfsSync(dir)
  return Number(st.bavail) * Number(st.bsize)
}

/** 書き出し先の名前から、並べて書くファイルの頭(拡張子を除いた所) */
export function premiereSidecarBase(xmlPath: string): string {
  const ext = extname(xmlPath)
  return ext.toLowerCase() === '.xml' ? xmlPath.slice(0, -ext.length) : xmlPath
}

function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('EXPORT_CANCELED'))
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], {
      windowsHide: true
    })
    const untrack = trackProcess(child)
    const tail: string[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      tail.push(chunk.toString('utf-8'))
      if (tail.length > 200) tail.shift()
    })
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => {
      untrack()
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      untrack()
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('EXPORT_CANCELED'))
      if (code === 0) resolve()
      else reject(describeFfmpegExit(code, tail.join('')))
    })
  })
}

/**
 * XML・SRT・(選べば)見た目どおりのテロップを書く。`xmlWritePath` は XML を実際に書く場所
 * (途中で失敗しても完成品の名前で残らないよう、呼び出し側が仮の名前を渡す)。
 * 並べて書くファイルの名前は `payload.outputPath` から決める。
 */
export async function exportPremiereXml(
  payload: PremiereExportPayload,
  xmlWritePath: string,
  deps: PremiereExportDeps
): Promise<PremiereExportResult> {
  const progress = deps.onProgress ?? ((): void => {})
  progress(0, 'シーケンスを組み立て中')
  // T1 の「目」を閉じていれば、テロップ(絵・SRT・テロップのマーカー)は出さない。
  // 章・コーナーのマーカーはテロップの中身とは別なので、隠していても元の企画から残す
  const telopsHidden = payload.project.telopTrackHidden === true
  const v2 = projectV1ToV2(
    { ...projectForOutput(payload.project), aspectRatio: payload.aspectRatio },
    { resolution: payload.resolutionHeight }
  )
  const markerSource = telopsHidden
    ? projectV1ToV2(
        { ...payload.project, aspectRatio: payload.aspectRatio },
        { resolution: payload.resolutionHeight }
      )
    : v2
  const fps = v2.sequence.fps
  const total = sequenceDurationFrames(v2.sequence)
  const base = premiereSidecarBase(payload.outputPath)
  const sidecars = premiereSidecarPaths(payload.outputPath)
  const srtPath = sidecars.srt
  const markers = premiereMarkers(payload.project, markerSource, {
    telops: payload.telopMarkers !== false && !telopsHidden,
    reviews: payload.reviews
  })

  let telopMedia: { width: number; height: number; clips: PremiereOverlayClip[] } | undefined
  let telopPath: string | undefined
  /** PNG を書いている一時フォルダ(最後に本来のフォルダへ入れ替える) */
  let pngStage: string | null = null
  /** SRT を書いている一時ファイル(最後に置き換える) */
  let srtPartial: string | null = null
  /** アプリのキャッシュの中の素材を写している一時フォルダ(最後に `名前_media/` へ入れ替える) */
  let mediaStage: string | null = null
  try {
    const layer = payload.telopLayer
    if (payload.telopMode !== 'text' && layer && layer.runs.length > 0) {
      if (layer.width !== v2.sequence.width || layer.height !== v2.sequence.height)
        throw new Error('テロップの層の大きさがシーケンスと食い違っています')
      const scratch = mkdtempSync(join(tmpdir(), 've-premiere-'))
      try {
        const imagePaths = materializeTelopLayer(layer, () => scratch)?.imagePaths ?? []
        if (payload.telopMode === 'png') {
          // フォルダの名前は ASCII の決まった後ろ(素材のフォルダに日本語があっても、PNG の名前は短く)
          const dir = sidecars.telopDir
          assertDirUsable(dir, 'テロップの PNG ')
          // そのフォルダの telop_*.png を企画の素材として使っていれば、片付けで消さないよう止める
          const used = telopPngsUsedAsAssets(dir, payload.project.assets)
          if (used.length > 0)
            throw new Error(
              `「${basename(dir)}」の ${used.slice(0, 3).join('・')}${used.length > 3 ? ' ほか' : ''} は` +
                'この企画の素材として使われているため、テロップの PNG で上書きできません。' +
                'XML を別の名前で書き出してください'
            )
          // PNG は隣の一時フォルダに書き、XML と SRT を書き終えてから入れ替える(中止・失敗で、前回の XML が
          // 消えた PNG を指したまま残らないように)
          mkdirSync(dirname(dir), { recursive: true })
          pngStage = mkdtempSync(`${dir}.partial-`)
          const stage = pngStage
          telopPath = dir
          // 先に並べ方と写す画像を決め、写すのは後でまとめて(非同期・中止が効くように)
          const copied = new Map<number, string>()
          const copies: { src: string; dst: string }[] = []
          const clips: PremiereOverlayClip[] = []
          const runs = [...layer.runs].sort((a, b) => a.startFrame - b.startFrame)
          for (const r of runs) {
            if (r.image <= 0 || r.endFrame <= r.startFrame) continue
            let path = copied.get(r.image)
            if (!path) {
              const src = imagePaths[r.image]
              if (!src) throw new Error('テロップの層の画像が見つかりません')
              const name = `telop_${String(copied.size + 1).padStart(6, '0')}.png`
              path = join(dir, name)
              copies.push({ src, dst: join(stage, name) })
              copied.set(r.image, path)
            }
            const last = clips[clips.length - 1]
            // 同じ画像が続く区間は 1 本にまとめる
            if (
              last &&
              last.path === path &&
              last.startFrame + last.durationFrames === r.startFrame
            )
              last.durationFrames += r.endFrame - r.startFrame
            else
              clips.push({
                path,
                startFrame: r.startFrame,
                durationFrames: r.endFrame - r.startFrame,
                still: true
              })
          }
          for (let i = 0; i < copies.length; i += COPY_BATCH) {
            if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
            await Promise.all(copies.slice(i, i + COPY_BATCH).map((c) => copyFile(c.src, c.dst)))
            const n = Math.min(copies.length, i + COPY_BATCH)
            progress(
              (n / copies.length) * 90,
              `テロップの画像を書き出し中(${n}/${copies.length} 枚)`
            )
          }
          if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
          telopMedia = { width: layer.width, height: layer.height, clips }
        } else {
          const movPath = sidecars.telopMov
          const list = telopConcatList(layer.runs, imagePaths, 0, total, fps)
          if (list) {
            // 尺に比例して大きくなる(1080p・3 時間で約 12GB)。書き始める前に空きを確かめる
            const need = Math.ceil(
              total * layer.width * layer.height * PRORES_BYTES_PER_PIXEL_FRAME + 256 * 1024 * 1024
            )
            const free = (deps.freeBytes ?? defaultFreeBytes)(dirname(movPath))
            if (free < need)
              throw new Error(
                `テロップの ProRes 4444 には約 ${(need / 1024 ** 3).toFixed(1)}GB 必要ですが、` +
                  `書き出し先の空きは ${(free / 1024 ** 3).toFixed(1)}GB です。` +
                  '空きを作るか、「透過 PNG」か「文字だけ」を選んでください'
              )
            const listPath = join(scratch, 'telop.ffconcat')
            writeFileSync(listPath, list, 'utf-8')
            progress(5, 'テロップを ProRes 4444(透過)に書き出し中')
            const partial = join(dirname(movPath), `.${basename(movPath)}.partial.mov`)
            try {
              await runFfmpeg(
                deps.ffmpegPath,
                [
                  '-f',
                  'concat',
                  '-safe',
                  '0',
                  '-i',
                  listPath,
                  '-vf',
                  `fps=${fps.num}/${fps.den},format=yuva444p10le`,
                  '-frames:v',
                  String(total),
                  '-c:v',
                  'prores_ks',
                  '-profile:v',
                  '4444',
                  '-alpha_bits',
                  '16',
                  '-vendor',
                  'apl0',
                  '-pix_fmt',
                  'yuva444p10le',
                  '-an',
                  partial
                ],
                deps.signal
              )
              renameSync(partial, movPath)
            } finally {
              rmSync(partial, { force: true })
            }
            telopPath = movPath
            telopMedia = {
              width: layer.width,
              height: layer.height,
              clips: [
                {
                  path: movPath,
                  startFrame: 0,
                  durationFrames: total,
                  still: false,
                  sourceInFrame: 0,
                  fileFrames: total
                }
              ]
            }
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }

    progress(95, 'XML を書き出し中')
    // 音声のチャンネル数(モノラルは 1 本、ステレオは L・R の 2 本のトラックに書く)。
    // ffprobe は少しずつ起こし、そのたびに中止を見る
    const audioChannels = new Map<string, number>()
    if (deps.probeChannels) {
      const probe = deps.probeChannels
      const used = new Set(v2.sequence.audioTracks.flatMap((t) => t.items.map((i) => i.assetId)))
      const assets = v2.assets.filter((a) => used.has(a.id) && a.hasAudio)
      for (let i = 0; i < assets.length; i += PROBE_CONCURRENCY) {
        if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
        const batch = assets.slice(i, i + PROBE_CONCURRENCY)
        const counts = await Promise.all(batch.map((a) => probe(a.filePath).catch(() => undefined)))
        batch.forEach((a, k) => {
          const n = counts[k]
          if (n !== undefined) audioChannels.set(a.id, n)
        })
      }
      if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
    }
    // アプリのキャッシュ(設定フォルダ)の中の素材は XML の隣の `名前_media/` へ写し、XML はそちらを指す。
    // PNG と同じく一時フォルダに写し、XML と SRT を書き終えてから入れ替える(失敗・中止で半端に残さない)
    const usedIds = new Set(
      [...v2.sequence.videoTracks, ...v2.sequence.audioTracks].flatMap((t) =>
        t.items.flatMap((i) => ('assetId' in i && typeof i.assetId === 'string' ? [i.assetId] : []))
      )
    )
    const mediaCopies = premiereMediaCopies(v2.assets, usedIds, deps.appCacheDirs ?? [])
    const mediaDir = sidecars.mediaDir
    let sequence = v2
    if (mediaCopies.length > 0) {
      assertDirUsable(mediaDir, '写した素材')
      const names = [...new Set(mediaCopies.map((c) => c.name))]
      // 写す先を、この企画の素材として使っていれば止める(入れ替えで消えるため)
      const used = names.filter((n) =>
        payload.project.assets.some((a) =>
          [a.filePath, a.proxyPath, a.denoisedFrom, a.proxyBeforeDenoise].some(
            (x) => x && basename(x) === n && isSamePath(dirname(x), mediaDir)
          )
        )
      )
      if (used.length > 0)
        throw new Error(
          `「${basename(mediaDir)}」の ${used.slice(0, 3).join('・')}${used.length > 3 ? ' ほか' : ''} は` +
            'この企画の素材として使われているため、上書きできません。XML を別の名前で書き出してください'
        )
      const sources = [...new Map(mediaCopies.map((c) => [c.name, c.from])).entries()]
      const need = sources.reduce((t, [, from]) => t + statSync(from).size, 0) + 64 * 1024 * 1024
      mkdirSync(dirname(mediaDir), { recursive: true })
      const free = (deps.freeBytes ?? defaultFreeBytes)(dirname(mediaDir))
      if (free < need)
        throw new Error(
          `本編で使っているアプリの中のファイル(ノイズ除去後のマイクの音など)を XML の隣へ写すのに約 ` +
            `${(need / 1024 ** 3).toFixed(1)}GB 必要ですが、書き出し先の空きは ${(free / 1024 ** 3).toFixed(1)}GB です`
        )
      mediaStage = mkdtempSync(`${mediaDir}.partial-`)
      for (let i = 0; i < sources.length; i++) {
        if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
        const [name, from] = sources[i]
        progress(95, `マイクの音などを XML の隣へ写し中(${i + 1}/${sources.length} 本)`)
        await copyFile(from, join(mediaStage, name))
      }
      if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
      const target = new Map(mediaCopies.map((c) => [c.assetId, join(mediaDir, c.name)]))
      sequence = {
        ...v2,
        assets: v2.assets.map((a) => (target.has(a.id) ? { ...a, filePath: target.get(a.id)! } : a))
      }
    }
    const result = buildPremiereXml(sequence, {
      audioChannels,
      name: payload.project.name || safeFileBaseName(basename(base)),
      dropFrame: payload.dropFrame !== false,
      markers,
      ...(telopMedia ? { telopMedia } : {})
    })
    writeFileSync(xmlWritePath, result.xml, 'utf-8')
    // 既存の字幕の書き出しと同じく BOM 付き(Windows の Premiere・メモ帳で文字化けしない)。
    // SRT も一時ファイルに書き、PNG を入れ替えられてから置き換える(PNG の入れ替えが失敗したのに SRT だけ新しく
    // ならないように)
    srtPartial = join(dirname(srtPath), `.${basename(srtPath)}.partial`)
    writeFileSync(srtPartial, '﻿' + premiereSrt(v2), 'utf-8')
    // ここまで来たら入れ替える: 写した素材を `名前_media/` へ(同じ名前の前回の分は退避)、前回の telop_*.png を
    // 退避して今回の PNG を移す(どれかが失敗すれば、入れ替えた分を元に戻す)
    const mediaStaged = mediaStage
    const mediaNames = new Set(mediaCopies.map((c) => c.name.toLowerCase()))
    const mediaSwap = mediaStaged
      ? (deps.swapMedia ?? swapInTelopPngs)(mediaStaged, mediaDir, renameSync, (name) =>
          mediaNames.has(name.toLowerCase())
        )
      : null
    let swap: ReturnType<typeof swapInTelopPngs> | null = null
    try {
      swap = pngStage ? (deps.swapPngs ?? swapInTelopPngs)(pngStage, sidecars.telopDir) : null
    } catch (e) {
      mediaSwap?.rollback()
      throw e
    }
    try {
      renameSync(srtPartial, srtPath)
    } catch (e) {
      swap?.rollback()
      mediaSwap?.rollback()
      throw e
    }
    srtPartial = null
    swap?.commit()
    mediaSwap?.commit()
    progress(100, '完了')
    return {
      xmlPath: payload.outputPath,
      srtPath,
      ...(telopPath ? { telopPath } : {}),
      ...(mediaCopies.length > 0
        ? {
            media: {
              dir: mediaDir,
              files: [...new Map(mediaCopies.map((c) => [c.name, c.from])).entries()].map(
                ([name, from]) => ({ name, from })
              )
            }
          }
        : {}),
      warnings: result.warnings,
      stats: result.stats
    }
  } finally {
    if (pngStage) rmSync(pngStage, { recursive: true, force: true })
    if (mediaStage) rmSync(mediaStage, { recursive: true, force: true })
    if (srtPartial) rmSync(srtPartial, { force: true })
  }
}
