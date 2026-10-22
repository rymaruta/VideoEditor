import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../helpers/tempDir'

/**
 * 素材を調べるのに失敗したら、その素材を開いている子プロセス(ffmpeg・ffprobe)を残さずに失敗を返す。
 *
 * 試聴用の素材作りは ffprobe を2本(音声の形・映像の色と走査)並べて走らせ、片方が失敗した時点で
 * もう片方の終わりを待たずに失敗を返していた。Windows では開いたままのファイルは消せない・名前を
 * 変えられないので、失敗の直後に利用者が素材を消す・置き換えると「使用中」で失敗する
 * (CI では後片付けの rmSync が EBUSY で落ちていた)。
 * Linux では /proc/<pid>/fd、Windows ではその場で消せるかで確かめる
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath } from '@main/ffmpegService'
import { cachedEnvelope } from '@main/audioPcm'
import { ensurePreviewProxy } from '@main/previewProxyService'

const work = mkdtempSync(join(tmpdir(), 've-probe-release-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => removeTempDir(work))

/** このプロセスの子(孫も)のうち、file を開いているもの。Linux のみ */
function holdersOf(file: string): string[] {
  const children = new Map<number, number>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf-8')
      // pid (comm) state ppid ... — comm に空白・括弧が入りうるので最後の ')' の後を読む
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      children.set(Number(name), ppid)
    } catch {
      // 調べている間に終わったプロセス
    }
  }
  const isDescendant = (pid: number): boolean => {
    for (let p = children.get(pid); p !== undefined && p > 1; p = children.get(p))
      if (p === process.pid) return true
    return false
  }
  const holders: string[] = []
  for (const [pid] of children) {
    if (!isDescendant(pid)) continue
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`) === file) {
            holders.push(
              `${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ')}`
            )
          }
        } catch {
          // 閉じた記述子
        }
      }
    } catch {
      // 終わったプロセス
    }
  }
  return holders
}

/** 失敗した直後に、ファイルが誰にも開かれていないこと(Linux: /proc、Windows: その場で消せる) */
function expectReleased(file: string): void {
  if (process.platform === 'linux') expect(holdersOf(file)).toEqual([])
  if (process.platform === 'win32') {
    expect(() => unlinkSync(file)).not.toThrow()
    expect(existsSync(file)).toBe(false)
  }
}

describe.skipIf(!existsSync(ffmpegPath))(
  '調べられない素材の失敗で、素材を開いたままにしない',
  () => {
    // 並べた ffprobe の終わる順はその時々なので、何本か続けて確かめる(直す前は Linux でも大半で残った)
    const ROUNDS = 6

    it('試聴用の素材作り: 失敗を返した時点で ffprobe が素材を閉じている', async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const file = join(work, `proxy-not-media-${i}.mp4`)
        writeFileSync(file, 'これは動画ではありません'.repeat(100 + i))
        const err = await ensurePreviewProxy(file).catch((e: Error) => e)
        expect(err).toBeInstanceOf(Error)
        expectReleased(file)
      }
    })

    // 並べた ffprobe のうち後から起きたほうが遅い(Windows ではプロセスの起動・ウイルス対策の検査で
    // 数十〜数百 ms かかる)ときを、Linux で決まって起こす: 同じ素材への2本目以降の ffprobe は、
    // 素材を開いて 0.4 秒つかむ子プロセスを先に走らせてから本物を動かす。直す前は、1本目
    // (音声の形を調べる側)の失敗で返った時点で、2本目(映像の色・走査を調べる側)が素材を開いていた
    it.skipIf(process.platform !== 'linux')(
      '試聴用の素材作り: 後から起きた ffprobe が遅くても、終わるのを待ってから失敗を返す',
      async () => {
        type Probe = (file: string, cb: (err: unknown, data: unknown) => void) => void
        const realProbe = ffmpeg.ffprobe as unknown as Probe
        const calls = new Map<string, number>()
        const spy = vi.spyOn(ffmpeg, 'ffprobe').mockImplementation(((
          file: string,
          cb: (err: unknown, data: unknown) => void
        ) => {
          const n = (calls.get(file) ?? 0) + 1
          calls.set(file, n)
          if (n === 1) return realProbe.call(ffmpeg, file, cb)
          const holder = spawn('sh', ['-c', 'exec 3<"$0"; sleep 0.4', file])
          holder.on('close', () => realProbe.call(ffmpeg, file, cb))
        }) as unknown as typeof ffmpeg.ffprobe)
        try {
          for (let i = 0; i < 2; i++) {
            const file = join(work, `proxy-slow-${i}.mp4`)
            writeFileSync(file, 'これは動画ではありません'.repeat(100 + i))
            const err = await ensurePreviewProxy(file).catch((e: Error) => e)
            expect(err).toBeInstanceOf(Error)
            expect((err as Error).message).toMatch(/^素材を調べられませんでした/)
            expect(calls.get(file)).toBeGreaterThanOrEqual(2)
            expectReleased(file)
          }
        } finally {
          spy.mockRestore()
        }
      }
    )

    it('音の大きさの解析: 失敗を返した時点で ffmpeg が素材を閉じている', async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const file = join(work, `envelope-not-media-${i}.mp4`)
        writeFileSync(file, 'これは動画ではありません'.repeat(100 + i))
        const st = statSync(file)
        const err = await cachedEnvelope(ffmpegPath, join(work, 'cache'), {
          path: file,
          size: st.size,
          mtimeMs: st.mtimeMs
        }).catch((e: Error) => e)
        expect(err).toBeInstanceOf(Error)
        expectReleased(file)
      }
    })
  }
)
