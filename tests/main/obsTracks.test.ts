import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { extractAudioTracks } from '@main/obsTracks'

/**
 * ffmpeg の代わりに、出力先を開いて(切り詰めて)少しずつ書く小さな台本を使う(ffmpeg -y と同じ書き方)。
 * 呼ばれるたびに出力先を記録に1行足す。包絡線の読み取り(pipe:1)には 4 バイトの無音を返す。
 */
const work = mkdtempSync(join(tmpdir(), 've-obs-tracks-test-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const calls = join(work, 'calls.log')
const fake = join(work, 'fake-ffmpeg.sh')
writeFileSync(
  fake,
  `#!/bin/bash
out="\${@: -1}"
if [ "$out" = "pipe:1" ]; then printf '\\0\\0\\0\\0'; exit 0; fi
echo "$out" >> "${calls}"
exec 3>"$out"
for c in 0 1 2 3 4 5 6 7 8 9; do printf "$c" >&3; sleep 0.02; done
exec 3>&-
exit 0
`
)
chmodSync(fake, 0o755)

const video = join(work, 'rec.mkv')
writeFileSync(video, 'video bytes')
const probed = {
  path: video,
  relativePath: 'rec.mkv',
  duration: 10,
  hasVideo: true,
  hasAudio: true,
  size: 11,
  mtimeMs: 1000
}
const streams = [
  { index: 0, codec: 'aac' },
  { index: 1, codec: 'aac' }
]

describe('OBS の複数トラックの取り出しが同じ録画で重なったとき', () => {
  it.skipIf(process.platform === 'win32')(
    '2本とも書き終えたトラックを受け取り、ffmpeg は1トラック1回、一時ファイルも残らない',
    async () => {
      const outDir = join(work, 'extracted-tracks')
      const cacheDir = join(work, 'analysis-cache')
      mkdirSync(outDir, { recursive: true })
      // 収録フォルダの読み取りを Esc → 「新しい回」→ 同じフォルダで選び直すと、2本が重なって走る
      const first = extractAudioTracks(fake, outDir, cacheDir, probed, streams)
      await new Promise((r) => setTimeout(r, 60))
      const second = extractAudioTracks(fake, outDir, cacheDir, probed, streams)
      const results = await Promise.allSettled([first, second])
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        expect(r.value).toHaveLength(2)
        for (const t of r.value) {
          expect(readFileSync(t.path, 'latin1')).toBe('0123456789')
          expect(t.size).toBe(10)
        }
      }
      const runs = readFileSync(calls, 'utf8').trim().split('\n')
      expect(runs).toHaveLength(2)
      expect(new Set(runs).size).toBe(2)
      expect(readdirSync(outDir).filter((f) => f.includes('partial'))).toEqual([])
    },
    10_000
  )
})
