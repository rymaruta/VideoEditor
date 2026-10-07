import { describe, expect, it } from 'vitest'
import {
  craigSpeakerName,
  guessCameraRole,
  guessTrackRole,
  quietRatio
} from '../../src/shared/ingest/tracks'
import { classifyFootage, type ProbedFile } from '../../src/shared/ingest/classify'
import { silencedTrack } from '../../src/shared/roughCut/build'
import { coveredBy, sameVoice } from '../../src/shared/diarize/micTurns'
import { isSilentEnvelope, mixHasUnaccountedSound } from '../../src/shared/ingest/tracks'

describe('OBS の音声トラックの役割', () => {
  it('名前があれば名前で、無ければ1本目は全部入り、ほかは静かな時間の割合で', () => {
    expect(guessTrackRole(1, 'Mic/Aux', 0)).toBe('voice')
    expect(guessTrackRole(2, 'ゲーム音', 0.9)).toBe('game')
    expect(guessTrackRole(0, 'Discord', 0)).toBe('call')
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
    // 録音機の日時・連番の名前は話者にしない(ロケの収録を壊さない)
    expect(craigSpeakerName('240501-120000.WAV')).toBeNull()
    expect(craigSpeakerName('1-0001.wav')).toBeNull()
    expect(craigSpeakerName('2024-05-01 12-00-00.wav')).toBeNull()
    expect(craigSpeakerName('3-たろう.ogg')).toBe('たろう')
    expect(craigSpeakerName('4-2b_fan.flac')).toBe('2b_fan')
    expect(guessCameraRole('webcam/facecam.mp4', 640, 1920, 1)).toBe('face')
    expect(guessCameraRole('OBS/2026-10-07.mp4', 1920, 1920, 3)).toBe('screen')
    expect(guessCameraRole('rec/b.mp4', 640, 1920, 1)).toBe('face')
    expect(guessCameraRole('rec/a.mp4', 1920, 1920, 1)).toBe('screen')
    // 音声を2本持つ顔カメラ(空間オーディオなど)も、名前で顔カメラにする
    expect(guessCameraRole('webcam/face.mov', 1920, 1920, 2)).toBe('face')
    // 「cam」は単語のときだけ。言葉の一部(campaign・Camp)では顔カメラにしない
    expect(guessCameraRole('Elden Ring campaign/2024-05-01 20-00-00.mkv', 1920, 1920, 3)).toBe(
      'screen'
    )
    expect(guessCameraRole('Camp/rec.mkv', 1920, 1920, 1)).toBe('screen')
    expect(guessCameraRole('cam/rec.mp4', 1920, 1920, 1)).toBe('face')
    expect(guessCameraRole('Surface/rec.mkv', 1920, 1920, 3)).toBe('screen')
    expect(guessCameraRole('faceit match/rec.mkv', 1920, 1920, 3)).toBe('screen')
    expect(guessCameraRole('Facepunch Rust/rec.mkv', 1920, 1920, 3)).toBe('screen')
    expect(guessCameraRole('rec/face_2.mp4', 1920, 1920, 3)).toBe('face')
    expect(guessCameraRole('FaceCam.mov', 1920, 1920, 2)).toBe('face')
    for (const face of [
      'FaceCamera.mp4',
      'facecamera/rec.mp4',
      'FaceCams/rec.mp4',
      'faceRec.mp4',
      'FaceOnly.mp4',
      'faces.mp4',
      'face-cam.mp4',
      'Face Camera.mp4'
    ])
      expect(guessCameraRole(face, 1920, 1920, 2), face).toBe('face')
    for (const screen of [
      'FACEIT/rec.mkv',
      'facebook live.mp4',
      'Interface.mkv',
      'Preface/rec.mkv'
    ])
      expect(guessCameraRole(screen, 1920, 1920, 2), screen).toBe('screen')
    expect(guessCameraRole('rec/Camera2.mp4', 1920, 1920, 1)).toBe('face')
    expect(guessCameraRole('rec\\顔.mp4', 1920, 1920, 1)).toBe('face')
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
    trackRole?: string,
    trackOf?: string
  ): { id: string; kind: string; trackRole?: string; trackOf?: string } => ({
    id,
    kind,
    trackRole,
    trackOf
  })
  it('ゲーム音があれば全部入りを鳴らさない。無ければ全部入りを鳴らし、取り出した声は鳴らさない', () => {
    const withGame = [
      src('mix', 'audio', 'mix', 'obs'),
      src('v', 'mic', 'voice', 'obs'),
      src('g', 'audio', 'game', 'obs'),
      src('craig', 'mic')
    ]
    expect(withGame.map((s) => silencedTrack(withGame, s.id))).toEqual([true, false, false, false])
    const mixOnly = [
      src('mix', 'audio', 'mix', 'obs'),
      src('v', 'mic', 'voice', 'obs'),
      src('craig', 'mic')
    ]
    expect(mixOnly.map((s) => silencedTrack(mixOnly, s.id))).toEqual([false, true, false])
    const plain = [src('pin', 'mic')]
    expect(silencedTrack(plain, 'pin')).toBe(false)
  })

  it('判断は同じ録画から取り出したトラックの中だけで行う(別の録画のゲーム音で全部入りを消さない)', () => {
    const two = [
      src('mixA', 'audio', 'mix', 'A'),
      src('vA', 'mic', 'voice', 'A'),
      src('gB', 'audio', 'game', 'B'),
      src('vB', 'mic', 'voice', 'B')
    ]
    expect(two.map((s) => silencedTrack(two, s.id))).toEqual([false, true, false, false])
    // 声のトラックが無い(1本目が全部入り・2本目がゲーム音だけ)なら、全部入りを鳴らし、ゲーム音は重ねない
    const noVoice = [src('mix', 'audio', 'mix', 'obs'), src('g', 'audio', 'game', 'obs')]
    expect(noVoice.map((s) => silencedTrack(noVoice, s.id))).toEqual([false, true])
    // 役割だけあって元の録画が分からない(手で役割を付けた)音源は消さない
    const manual = [src('m', 'mic', 'voice'), src('g', 'audio', 'game')]
    expect(manual.map((s) => silencedTrack(manual, s.id))).toEqual([false, false])
  })
})

describe('通話のトラック・無音のトラック', () => {
  const env = (f: (i: number) => number, n = 30_000): Float32Array =>
    Float32Array.from({ length: n }, (_, i) => f(i))
  const speaking = (period: number, phase: number) => (i: number) =>
    Math.floor(i / period + phase) % 2 === 0 ? 0.2 : 0.0005
  it('名前で通話・声を分け、ずっと無音のトラックは声にしない', () => {
    expect(guessTrackRole(2, 'Discord', 0.6)).toBe('call')
    expect(guessTrackRole(1, 'Mic/Aux', 0.6)).toBe('voice')
    expect(guessTrackRole(2, 'Discord', 1, true)).toBe('game')
    expect(guessTrackRole(2, undefined, 1, true)).toBe('game')
    expect(isSilentEnvelope(new Float32Array(1000))).toBe(true)
    expect(isSilentEnvelope(env(speaking(300, 0)))).toBe(false)
  })

  it('全部入りに、ほかのトラックに無い声(配信者)が残っていれば分かる', () => {
    const game = env(() => 0.05)
    const streamer = env(speaking(300, 0))
    const friends = env(speaking(300, 1))
    const mix = env((i) => Math.sqrt(game[i] ** 2 + streamer[i] ** 2 + friends[i] ** 2))
    // トラック2 がゲーム音・トラック3 が友達の声だけ: 配信者の声は全部入りにしか無い
    expect(mixHasUnaccountedSound(mix, [game, friends])).toBe(true)
    // トラック3 が配信者の声: 全部入りはほかのトラックで説明できる
    const mix2 = env((i) => Math.sqrt(game[i] ** 2 + streamer[i] ** 2))
    expect(mixHasUnaccountedSound(mix2, [game, streamer])).toBe(false)
  })

  it('通話は全部入りを鳴らすときは止める。配信者の声のトラックがあれば、全部入りを止めて通話を鳴らす', () => {
    const s = (
      id: string,
      kind: string,
      trackRole: string
    ): { id: string; kind: string; trackRole: string; trackOf: string } => ({
      id,
      kind,
      trackRole,
      trackOf: 'obs'
    })
    const noVoice = [s('mix', 'audio', 'mix'), s('g', 'audio', 'game'), s('c', 'mic', 'call')]
    expect(noVoice.map((x) => silencedTrack(noVoice, x.id))).toEqual([false, true, true])
    const withVoice = [...noVoice, s('v', 'mic', 'voice')]
    expect(withVoice.map((x) => silencedTrack(withVoice, x.id))).toEqual([
      true,
      false,
      false,
      false
    ])
  })

  it('通話のトラックの声が、1人ずつのマイクを合わせたものに入っていれば同じ声', () => {
    // 2人が交互に話し、間に誰も話さない時間がある(3 拍に 1 回ずつ)
    const third = (k: number) => (i: number) => (Math.floor(i / 300) % 3 === k ? 0.2 : 0.0005)
    const a = env(third(0))
    const b = env(third(1))
    const call = env((i) => Math.max(a[i], b[i]))
    expect(sameVoice({ id: 'c', envelope: call }, { id: 'a', envelope: a })).toBe(false)
    expect(
      coveredBy({ id: 'c', envelope: call }, [
        { id: 'a', envelope: a },
        { id: 'b', envelope: b }
      ])
    ).toBeGreaterThan(0.9)
    expect(coveredBy({ id: 'c', envelope: call }, [{ id: 'a', envelope: a }])).toBeLessThan(0.6)
  })
})
