import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 素材の長さは映像・音声のストリームから決める(実地テスト: m4b のテキストトラックが混ざった 180 秒の
 * カメラ素材が 1550 秒として取り込まれ、仮編集が「25分50秒」・末尾の映像が 7.9 秒止まった)。
 * 同梱の ffprobe(4.0.2)は、入れ物の長さ(format.duration)にデータ・字幕のトラックの長さまで含める
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

// 取り込みが読み込む同期の Worker の入口(読み込むとその場で動き出す)は使わない
vi.mock('@main/syncWorker?modulePath', () => ({ default: '' }))

import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import { scanFootage } from '@main/footageService'
import { mediaDurationSeconds } from '@main/mediaDuration'

const work = mkdtempSync(join(tmpdir(), 've-probe-dur-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('mediaDurationSeconds — 映像・音声のストリームの長さ', () => {
  it('データ・字幕のトラックが長くても、映像・音声の終わりを長さにする', () => {
    expect(
      mediaDurationSeconds({ duration: '1550.0', start_time: '0' }, [
        { codec_type: 'video', duration: '180.0', start_time: '0' },
        { codec_type: 'audio', duration: '179.98', start_time: '0' },
        { codec_type: 'data', duration: '1550.0', start_time: '0' }
      ])
    ).toBeCloseTo(180, 6)
    // 開始時刻がずれた入れ物は、入れ物の頭からの長さ
    expect(
      mediaDurationSeconds({ duration: '40', start_time: '1.4' }, [
        { codec_type: 'video', duration: '10', start_time: '1.4' },
        { codec_type: 'audio', duration: '10.2', start_time: '1.5' },
        { codec_type: 'subtitle', duration: '40', start_time: '1.4' }
      ])
    ).toBeCloseTo(10.3, 6)
    // Matroska はストリームの長さをタグ(DURATION)に持つ
    expect(
      mediaDurationSeconds({ duration: '900' }, [
        { codec_type: 'video', tags: { DURATION: '00:03:00.000000000' } },
        { codec_type: 'subtitle', tags: { DURATION: '00:15:00.000000000' } }
      ])
    ).toBeCloseTo(180, 6)
  })

  it('MP4・MOV のストリームの長さは時刻 0 からの値(遅れて始まる音声の遅れを二重に足さない)', () => {
    // 同梱の ffprobe の実際の値: 音声を 1.5 秒遅らせ、字幕を 30 秒まで付けた MP4
    const mov = 'mov,mp4,m4a,3gp,3g2,mj2'
    expect(
      mediaDurationSeconds({ duration: '30', start_time: '0', format_name: mov }, [
        { codec_type: 'video', duration: '5.5', start_time: '0' },
        { codec_type: 'audio', duration: '5.5', start_time: '1.476009' },
        { codec_type: 'subtitle', duration: '30', start_time: '0' }
      ])
    ).toBeCloseTo(5.5, 6)
    // 音声が映像より後まで続くなら、音声の終わり(6.5 秒)
    expect(
      mediaDurationSeconds({ duration: '30', start_time: '0', format_name: mov }, [
        { codec_type: 'video', duration: '5.5', start_time: '0' },
        { codec_type: 'audio', duration: '6.5', start_time: '1.476009' },
        { codec_type: 'subtitle', duration: '30', start_time: '0' }
      ])
    ).toBeCloseTo(6.5, 6)
  })

  it('映像・音声だけの素材・ストリームの長さが分からない素材は、これまでどおり入れ物の長さ', () => {
    expect(
      mediaDurationSeconds({ duration: '12.5' }, [
        { codec_type: 'video', duration: '12.4' },
        { codec_type: 'audio', duration: '12.5' }
      ])
    ).toBe(12.5)
    expect(
      mediaDurationSeconds({ duration: '30' }, [
        { codec_type: 'video', duration: 'N/A' },
        { codec_type: 'data', duration: '30' }
      ])
    ).toBe(30)
    // 入れ物の長さが無ければ映像、それも無ければ音声
    expect(
      mediaDurationSeconds({ duration: 'N/A' }, [{ codec_type: 'audio', duration: '3' }])
    ).toBe(3)
    expect(mediaDurationSeconds(undefined, [])).toBeNull()
  })
})

describe.skipIf(!existsSync(ffmpegPath))(
  '字幕のトラックが長い素材の取り込み(同梱の ffprobe)',
  () => {
    it('取り込み(scanFootage)・素材の読み込み(probeMedia)とも、映像・音声の長さ(2 秒)にする', async () => {
      const root = join(work, 'footage', 'CAM_A')
      mkdirSync(root, { recursive: true })
      const srt = join(work, 'cue.srt')
      // 字幕は 30 秒まで続く(映像・音声は 2 秒)
      writeFileSync(
        srt,
        '1\n00:00:00,000 --> 00:00:01,000\nhi\n\n2\n00:00:29,000 --> 00:00:30,000\nend\n'
      )
      const file = join(root, 'A001.mp4')
      execFileSync(ffmpegPath, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=64x36:r=10:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:d=2',
        '-i',
        srt,
        '-map',
        '0',
        '-map',
        '1',
        '-map',
        '2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-c:s',
        'mov_text',
        file
      ])
      const probed = await probeMedia(file)
      expect(probed.duration).toBeGreaterThan(1.9)
      expect(probed.duration).toBeLessThan(2.2)
      const scan = await scanFootage(join(work, 'footage'), () => {})
      const all = scan.sources.flatMap((s) => s.files)
      expect(all).toHaveLength(1)
      expect(all[0].duration).toBeGreaterThan(1.9)
      expect(all[0].duration).toBeLessThan(2.2)
    })

    it('音声が 1.5 秒遅れて始まる MP4(字幕付き)を、映像の長さ(5.5 秒)で読む', async () => {
      const srt = join(work, 'cue-late.srt')
      writeFileSync(
        srt,
        '1\n00:00:00,000 --> 00:00:01,000\nhi\n\n2\n00:00:29,000 --> 00:00:30,000\nend\n'
      )
      const file = join(work, 'late-audio.mp4')
      execFileSync(ffmpegPath, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=64x36:r=10:d=5.5',
        '-itsoffset',
        '1.5',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:d=4',
        '-i',
        srt,
        '-map',
        '0',
        '-map',
        '1',
        '-map',
        '2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-c:s',
        'mov_text',
        file
      ])
      const probed = await probeMedia(file)
      expect(probed.duration).toBeGreaterThan(5.4)
      expect(probed.duration).toBeLessThan(5.6)
    })
  }
)
