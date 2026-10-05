import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TelopLayerPayload } from '@shared/telop/layer'

/**
 * 書き出しのテロップの層の画像を、**届いた順にディスクへ書いておく**置き場。
 *
 * これまでは画面のプロセスが全部の画像(PNG)をメモリに溜め、書き出しの IPC 1回に載せていた。
 * ループの動き(震える・波打つ)・1文字ずつの登場が入ると画像はテロップ1枚で数十〜数百枚になり、
 * 長尺では数万枚・数 GB になる。1回の IPC に載せると、送る側も受ける側もその丸ごとを
 * 複製して持つ(実測: 100枚・2,228枚・145MB で画面のプロセスが 1.03GB、main が +270MB。
 * 60分・1000枚・24,595枚では送れずに画面のプロセスが消えた)。
 *
 * ここでは画面のプロセスが数 MB ずつ送り、受け取ったらすぐ一時フォルダへ書いて手放す。
 * 書き出しの側は `materializeTelopLayer` で画像のパスの一覧だけを受け取る。
 * 束の番号(`id`)はこちらが作るので、画面のプロセスから任意のパスを読ませることはない。
 */

interface Stage {
  dir: string
  width: number
  height: number
  /** 書き終えた画像の番号 */
  written: Set<number>
  /** 書き出しが使っている間は、次の `begin` で片付けない */
  inUse: boolean
}

const stages = new Map<string, Stage>()
let nextId = 1

/** 一時フォルダの名前の頭(前回落ちたときの残りを起動時に片付けるのに使う) */
export const TELOP_STAGE_PREFIX = 've-telop-'

/** 1枚の大きさの上限(4K の RGBA を無圧縮で書いても 33MB。これを超えるものは壊れている) */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
/** 1つの束の画像の枚数の上限(60分・60fps の全フレームでも 216,000 枚) */
const MAX_IMAGES = 1_000_000

export function telopImagePath(dir: string, index: number): string {
  return join(dir, `telop_${String(index).padStart(6, '0')}.png`)
}

/** 新しい束を始める。書き出しに使っていない古い束(中止・失敗で残ったもの)はここで片付ける */
export function beginTelopLayer(width: number, height: number): string {
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
    throw new Error('テロップの層の大きさが正しくありません')
  }
  for (const [id, s] of stages) if (!s.inUse) releaseTelopLayer(id)
  const id = `t${nextId++}`
  stages.set(id, {
    dir: mkdtempSync(join(tmpdir(), TELOP_STAGE_PREFIX)),
    width,
    height,
    written: new Set(),
    inUse: false
  })
  return id
}

/** 画像をまとめて書く。書き終えてから返る(送る側はこれを待つので、溜め込みすぎない) */
export async function appendTelopLayerImages(
  id: string,
  firstIndex: number,
  images: readonly Uint8Array[]
): Promise<void> {
  const stage = stages.get(id)
  if (!stage) throw new Error('テロップの層が見つかりません(中止されたか、古い書き出しです)')
  if (!Number.isInteger(firstIndex) || firstIndex < 0 || firstIndex + images.length > MAX_IMAGES) {
    throw new Error('テロップの層の画像の番号が正しくありません')
  }
  for (const [k, bytes] of images.entries()) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('テロップの層の画像が正しくありません')
    }
    // 1枚ずつ待つ(並べて書くと、数千枚の書き込みが同時に開いてファイルの数の上限に当たる)
    await writeFile(telopImagePath(stage.dir, firstIndex + k), bytes)
    // 書いている間に中止(片付け)されたら、続きは書かない
    if (stages.get(id) !== stage) return
    stage.written.add(firstIndex + k)
  }
}

/** 束を片付ける(何度呼んでもよい) */
export function releaseTelopLayer(id: string): void {
  const stage = stages.get(id)
  if (!stage) return
  stages.delete(id)
  try {
    rmSync(stage.dir, { recursive: true, force: true })
  } catch {
    // 消せなければ次の起動で(`cleanupStaleSegmentDirs`)
  }
}

/** アプリを閉じるとき */
export function releaseAllTelopLayers(): void {
  for (const id of [...stages.keys()]) releaseTelopLayer(id)
}

/** 書き出しが使う形(区間と、画像のパス) */
export interface MaterializedTelopLayer {
  width: number
  height: number
  runs: TelopLayerPayload['runs']
  imagePaths: string[]
}

/**
 * 層を書き出しで使える形(画像のパスの一覧)にする。画像が無ければ null。
 * - `stagedId` なら、置き場に書いてある画像のパスを返す(足りない・番号の外を指す区間があれば止める)
 * - `images` なら、`scratchDir` へ書いてからパスを返す(テスト・小さい層)
 */
export function materializeTelopLayer(
  layer: TelopLayerPayload,
  scratchDir: () => string
): MaterializedTelopLayer | null {
  let imagePaths: string[]
  if (layer.stagedId !== undefined) {
    const stage = stages.get(layer.stagedId)
    if (!stage) throw new Error('テロップの層が見つかりません(中止されたか、古い書き出しです)')
    const count = layer.imageCount ?? 0
    if (count === 0) return null
    if (stage.width !== layer.width || stage.height !== layer.height) {
      throw new Error('テロップの層の大きさが食い違っています')
    }
    for (let i = 0; i < count; i++) {
      if (!stage.written.has(i)) throw new Error('テロップの層の画像が届いていません')
    }
    imagePaths = Array.from({ length: count }, (_, i) => telopImagePath(stage.dir, i))
  } else {
    const images = layer.images ?? []
    if (images.length === 0) return null
    const dir = scratchDir()
    imagePaths = images.map((bytes, i) => {
      const p = telopImagePath(dir, i)
      writeFileSync(p, bytes)
      return p
    })
  }
  for (const r of layer.runs) {
    if (!Number.isInteger(r.image) || r.image < 0 || r.image >= imagePaths.length) {
      throw new Error('テロップの層の区間が、無い画像を指しています')
    }
  }
  return { width: layer.width, height: layer.height, runs: layer.runs, imagePaths }
}

/**
 * 書き出しのあいだ束を使用中にし、終わったら(成功・失敗・中止のどれでも)片付ける。
 * `stagedId` の無い層ではそのまま走らせる
 */
export async function withTelopLayer<T>(
  layer: TelopLayerPayload | null | undefined,
  run: () => Promise<T>
): Promise<T> {
  const id = layer?.stagedId
  const stage = id !== undefined ? stages.get(id) : undefined
  if (stage) stage.inUse = true
  try {
    return await run()
  } finally {
    if (id !== undefined) releaseTelopLayer(id)
  }
}
