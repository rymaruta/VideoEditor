import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { createServer, type RequestListener, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))
// 取り込んだ後の長さ調べ(ffmpeg)は、ここでは見ない
vi.mock('@main/ffmpegService', () => ({ probeMedia: async () => ({ duration: 3 }) }))

import { downloadAudioAsset } from '@main/audioLibraryService'

const work = mkdtempSync(join(tmpdir(), 've-audio-dl-test-'))
state.userData = join(work, 'userdata')
const libraryDir = join(state.userData, 'audio-library')
mkdirSync(libraryDir, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  for (const f of readdirSync(libraryDir)) rmSync(join(libraryDir, f), { force: true })
})

function serve(handler: RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}/song.mp3`)
    })
  })
}

/**
 * 決まらない Promise で vitest の worker を塞がないよう、短い時間で打ち切って結果を返す
 * (直す前は永久に決まらなかった)
 */
async function outcome(p: Promise<unknown>, ms = 3000): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const r = await Promise.race([
    p.then(
      () => 'resolved',
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`
    ),
    new Promise<string>((res) => {
      timer = setTimeout(() => res('hung'), ms)
    })
  ])
  clearTimeout(timer)
  return r
}

describe('BGM・効果音のダウンロードが本文の途中で切れたとき', () => {
  it('永久に待たず「通信が途中で切れました」で失敗し、書きかけのファイルを残さない', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '100000' })
      res.write(Buffer.alloc(1000))
      // 配信元が本文の途中で落ちる
      setTimeout(() => res.socket?.destroy(), 30)
    })
    const result = await outcome(downloadAudioAsset(url, '途中で切れる曲'))
    expect(result).toBe('rejected: 通信が途中で切れました。もう一度お試しください。')
    expect(readdirSync(libraryDir)).toEqual([])
  })

  it('最後まで届いたときは、これまでどおり取り込める', async () => {
    const body = Buffer.alloc(5000, 1)
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) })
      res.end(body)
    })
    const p = downloadAudioAsset(url, '届く曲')
    expect(await outcome(p)).toBe('resolved')
    const { duration } = await p
    expect(duration).toBe(3)
    expect(readdirSync(libraryDir)).toHaveLength(1)
  })
})
