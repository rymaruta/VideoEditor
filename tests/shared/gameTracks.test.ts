import { describe, expect, it } from 'vitest'
import {
  craigSpeakerName,
  guessCameraRole,
  guessTrackRole,
  quietRatio
} from '../../src/shared/ingest/tracks'
import { classifyFootage, type ProbedFile } from '../../src/shared/ingest/classify'
import { silencedTrack } from '../../src/shared/roughCut/build'

describe('OBS の音声トラックの役割', () => {
  it('名前があれば名前で、無ければ1本目は全部入り、ほかは静かな時間の割合で', () => {
    expect(guessTrackRole(1, 'Mic/Aux', 0)).toBe('voice')
    expect(guessTrackRole(2, 'ゲーム音', 0.9)).toBe('game')
    expect(guessTrackRole(0, 'Discord', 0)).toBe('voice')
    expect(guessTrackRole(0, undefined, 0.9)).toBe('mix')
    expect(guessTrackRole(1, undefined, 0.5)).toBe('voice')
    expect(guessTrackRole(2, undefined, 0.05)).toBe('game')
  })

  it('静かな時間の割合: 声は言葉の間が静か、ずっと鳴る音は静かな所がない', () => {
    const voice = Float32Array.from({ length: 1000 }, (_, i) => (i % 10 < 5 ? 0.2 : 0.001))
    const game = Float32Array.from({ length: 1000 }, (_, i) => 0.05 + 0.01 * Math.sin(i))
    expect(quietRatio(voice)).toBeCloseTo(0.5, 2)
    expect(quietRatio(game)).toBe(0)
    expect(quietRatio(new Float32Array(10))).toBe(1)
  })

  it('Craig のファイル名から話者の名前、顔カメラらしさ', () => {
    expect(craigSpeakerName('1-tomo.flac')).toBe('tomo')
    expect(craigSpeakerName('2-hanako_1234.flac')).toBe('hanako')
    expect(craigSpeakerName('ZOOM0001.WAV')).toBeNull()
    expect(guessCameraRole('webcam/facecam.mp4', 640, 1920, 1)).toBe('face')
    expect(guessCameraRole('OBS/2026-10-07.mp4', 1920, 1920, 3)).toBe('screen')
    expect(guessCameraRole('rec/b.mp4', 640, 1920, 1)).toBe('face')
    expect(guessCameraRole('rec/a.mp4', 1920, 1920, 1)).toBe('screen')
  })
})

describe('振り分け(取り出したトラック・Craig)', () => {
  const file = (relativePath: string, extra: Partial<ProbedFile> = {}): ProbedFile => ({
    path: `/r/${relativePath}`,
    relativePath,
    duration: 100,
    hasVideo: false,
    hasAudio: true,
    size: 1,
    ...extra
  })
  it('トラック・Craig のファイルは1本ずつ1つの音源にし、役割で種類を決める', () => {
    const sources = classifyFootage([
      file('OBS/a.mp4', { hasVideo: true, width: 1920, audioTracks: 2 }),
      file('OBS/a.mp4 · トラック1', {
        track: {
          parentPath: '/r/OBS/a.mp4',
          parentRelativePath: 'OBS/a.mp4',
          index: 0,
          role: 'mix'
        }
      }),
      file('OBS/a.mp4 · トラック2', {
        track: {
          parentPath: '/r/OBS/a.mp4',
          parentRelativePath: 'OBS/a.mp4',
          index: 1,
          title: 'マイク',
          role: 'voice'
        }
      }),
      file('craig/1-tomo.flac'),
      file('craig/2-hana.flac')
    ])
    expect(sources.map((s) => [s.name, s.kind, s.trackRole ?? s.cameraRole ?? null])).toEqual([
      ['カメラA', 'camera', 'screen'],
      ['tomo', 'mic', null],
      ['hana', 'mic', null],
      ['全部入り(トラック1)', 'audio', 'mix'],
      ['マイク(トラック2)', 'mic', 'voice']
    ])
  })
})

describe('鳴らすトラック(silencedTrack)', () => {
  const src = (
    id: string,
    kind: string,
    trackRole?: string
  ): { id: string; kind: string; trackRole?: string } => ({
    id,
    kind,
    trackRole
  })
  it('ゲーム音があれば全部入りを鳴らさない。無ければ全部入りを鳴らし、取り出した声は鳴らさない', () => {
    const withGame = [
      src('mix', 'audio', 'mix'),
      src('v', 'mic', 'voice'),
      src('g', 'audio', 'game'),
      src('craig', 'mic')
    ]
    expect(withGame.map((s) => silencedTrack(withGame, s.id))).toEqual([true, false, false, false])
    const mixOnly = [src('mix', 'audio', 'mix'), src('v', 'mic', 'voice'), src('craig', 'mic')]
    expect(mixOnly.map((s) => silencedTrack(mixOnly, s.id))).toEqual([false, true, false])
    const plain = [src('pin', 'mic')]
    expect(silencedTrack(plain, 'pin')).toBe(false)
  })
})
