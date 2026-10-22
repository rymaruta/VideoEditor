import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '@main/ffmpegService'
import { QcLogParser, mediaIssues, qcFilter } from '@shared/qc/media'
import type { QcIssue } from '@shared/qc/types'

/**
 * 書き出しの自動確認(QC)の黒味・フリーズの誤検知と見逃し(実地テスト: 3時間の記録映像)。
 * - 固定カメラの話者(頭だけ動く)を「画が止まっています」と 325 件出していた
 * - 暗いホールに小さく映る演台の場面(フィルムの浮いた黒)を「黒い画面」と出していた
 * わざと入れた止まり・黒は、どちらの場面の中でも見つける。
 *
 * 素材は ffmpeg で作る短いもの(12 秒・640×360)。書き出しと同じく圧縮してから測る
 */
const work = mkdtempSync(join(tmpdir(), 've-qc-false-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const DUR = 12

const made = new Map<string, string>()

function encode(out: string, inputs: string[], filter: string): string {
  const path = join(work, out)
  if (made.has(path)) return path
  made.set(path, path)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    ...inputs.flatMap((i) => ['-f', 'lavfi', '-i', i]),
    '-filter_complex',
    `${filter},format=yuv420p[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '30',
    path
  ])
  return path
}

/** 頭だけ動く、固定カメラの話者(画の 1% ほどの頭が数画素だけ揺れる) */
function talker(extra = ''): string {
  return encode(
    `talker${extra ? '-bad' : ''}.mp4`,
    [`color=c=0x606a78:s=640x360:r=30:d=${DUR}`, `color=c=0xd0a080:s=48x60:r=30:d=${DUR}`],
    `[0:v]noise=alls=40:allf=0,boxblur=2,drawbox=x=0:y=200:w=640:h=160:color=0x3a2a20:t=fill[bg];` +
      `[bg][1:v]overlay=x='300+4*sin(2*PI*t*0.7)+2*sin(2*PI*t*1.9)':y='110+3*sin(2*PI*t*0.5)'${extra}`
  )
}

/** 暗いホール(フィルムの浮いた黒)に、小さな演台と人が映る */
function darkHall(extra = ''): string {
  return encode(
    `dark${extra ? `-${made.size}` : ''}.mp4`,
    [
      `color=c=0x0f0f0f:s=640x360:r=30:d=${DUR}`,
      `color=c=0x8a5a3a:s=64x22:r=30:d=${DUR}`,
      `color=c=0xc0c8d0:s=12x16:r=30:d=${DUR}`
    ],
    `[0:v]noise=alls=6:allf=0[bg];[bg][1:v]overlay=x=300:y=250[p];` +
      `[p][2:v]overlay=x='310+3*sin(2*PI*t*0.7)+2*sin(2*PI*t*1.9)':y='234+2*sin(2*PI*t*0.5)'${extra}`
  )
}

/** 4〜9 秒を止め(5 秒)、9.5〜11 秒を黒にする */
const DEFECTS =
  `,split[x][y];[x][y]freezeframes=first=120:last=270:replace=120,` +
  `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,9.5,11)'`

/** ffmpeg のログ(標準エラー)を QC と同じ読み方で読み、知らせる項目にする */
function qcIssues(path: string): QcIssue[] {
  const res = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      path,
      '-filter_complex',
      qcFilter(true, false, DUR),
      '-map',
      '[qv]',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  expect(res.status).toBe(0)
  const p = new QcLogParser()
  for (const line of res.stderr.split(/\r\n|\r|\n/)) p.push(line)
  return mediaIssues(p.result(DUR), 'off')
}

const overlaps = (i: QcIssue, a: number, b: number): boolean => i.start < b && i.end > a

describe.skipIf(!existsSync(ffmpegPath))(
  'QC の黒味・フリーズ: 誤検知と見逃し',
  { timeout: 60000 },
  () => {
    it('頭だけ動く固定カメラの話者を「止まっています」と言わない', () => {
      expect(qcIssues(talker()).map((i) => i.message)).toEqual([])
    })

    it('暗いホールの小さな演台の場面を「黒い画面」「止まっています」と言わない', () => {
      expect(qcIssues(darkHall()).map((i) => i.message)).toEqual([])
    })

    it('わざと入れた止まり(5 秒)と黒(1.5 秒)は、どちらの場面でも見つける', () => {
      for (const path of [talker(DEFECTS), darkHall(DEFECTS)]) {
        const issues = qcIssues(path)
        const freeze = issues.filter((i) => i.kind === 'freeze' && overlaps(i, 4, 9))
        const black = issues.filter((i) => i.kind === 'black' && overlaps(i, 9.5, 11))
        expect(freeze.length, path).toBeGreaterThan(0)
        expect(Math.max(...freeze.map((i) => i.end - i.start))).toBeGreaterThanOrEqual(2)
        expect(black.length, path).toBe(1)
        expect(black[0].end - black[0].start).toBeGreaterThan(1.2)
        // ほかの所には何も出さない
        expect(issues.filter((i) => !freeze.includes(i) && !black.includes(i))).toEqual([])
      }
    })

    it('フィルムの浮いた黒の暗転(一様に暗い 1.5 秒)は黒として知らせる', () => {
      const path = darkHall(
        `,drawbox=x=0:y=0:w=iw:h=ih:color=0x0f0f0f:t=fill:enable='between(t,5,6.5)',noise=alls=4:allf=t`
      )
      const issues = qcIssues(path)
      expect(issues.map((i) => i.kind)).toEqual(['black'])
      expect(issues[0].start).toBeCloseTo(5, 0)
      expect(issues[0].end - issues[0].start).toBeGreaterThan(1.2)
    })
  }
)
