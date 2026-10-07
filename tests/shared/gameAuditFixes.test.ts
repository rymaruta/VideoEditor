import { describe, expect, it } from 'vitest'
import { tightenRanges } from '../../src/shared/cut/tighten'
import { TURN_RATE } from '../../src/shared/diarize/micTurns'
import { peakWindows, widenToLines } from '../../src/shared/structure/hype'
import { pickShortWindows } from '../../src/shared/structure/shorts'
import { stackSimultaneousTelops, stackedBottomTelops } from '../../src/shared/telop/stack'
import { settleTelopTimes } from '../../src/shared/telop/fromTranscript'
import type { TextOverlay, TextStyle } from '../../src/shared/types'
import { selectScenes, type Scene } from '../../src/shared/structure/scenes'
import { carriesVoice } from '../../src/shared/roughCut/build'
import {
  restyleSpeechTelops,
  restyleOverlays,
  speechLook,
  speechTelopStyle
} from '../../src/shared/telop/styles'
import { defaultTextStyle } from '../../src/shared/textStyle'

/**
 * ゲーム実況の監査(2026-10-07)で見つけた不具合の再発防止。
 * 鳴らすトラック・Craig の名前は `gameTracks.test.ts`、顔カメラの音は `gameTracksReal`(本物の書き出し)
 */

describe('発話の途中で区間を切らない(元の端にまたがる発話だけを丸ごと入れる)', () => {
  // 重なる掛け合い: A 10〜14、B 12〜20、C 18〜25
  const lines = [
    { start: 10, end: 14 },
    { start: 12, end: 20 },
    { start: 18, end: 25 }
  ]
  it('またがる発話のうち一番外まで(並び順によらない)。広げた先からさらには広げない', () => {
    expect(widenToLines(13, 15, lines)).toEqual([10, 20])
    expect(widenToLines(13, 15, [...lines].reverse())).toEqual([10, 20])
    expect(widenToLines(5, 8, lines)).toEqual([5, 8])
  })

  it('切れ目なく続く掛け合いでも、区間が会話の端まで広がらない。長すぎる発話は端で切る', () => {
    const chain: { start: number; end: number }[] = []
    for (let t = 0, k = 0; t < 600; k++) {
      const len = 3 + (k % 4)
      chain.push({ start: t, end: t + len })
      t += len - 0.3
    }
    const [a, b] = widenToLines(290, 320, chain)
    expect(a).toBeGreaterThan(283)
    expect(b).toBeLessThan(327)
    expect(widenToLines(50, 60, [{ start: 0, end: 100 }])).toEqual([50, 60])
    expect(widenToLines(50, 60, [{ start: 40, end: 70 }])).toEqual([40, 70])
    // ショートは山ごとに別の区間になり、どれも山を含む
    const shorts = pickShortWindows(
      [
        { start: 300, end: 301, riseDb: 10 },
        { start: 450, end: 451, riseDb: 9 }
      ],
      [],
      chain,
      { start: 0, end: 600 },
      { maxSec: 60 }
    )
    expect(shorts).toHaveLength(2)
    for (const [i, h] of [300, 450].entries()) {
      expect(shorts[i].start).toBeLessThanOrEqual(h)
      expect(shorts[i].end).toBeGreaterThanOrEqual(h + 1)
    }
  })
  it('山の前後の区間・ショートの区間も同じ', () => {
    const w = peakWindows(
      { start: 0, end: 100 },
      [{ start: 15, end: 15.5, lead: 1, tail: 0 }],
      lines
    )
    expect(w).toEqual([{ start: 12, end: 20 }])
    const shorts = pickShortWindows(
      [{ start: 15, end: 15.5, riseDb: 10 }],
      [],
      lines,
      { start: 0, end: 100 },
      { leadSec: 1, tailSec: 0, minSec: 1 }
    )
    expect(shorts[0].start).toBe(12)
    expect(shorts[0].end).toBe(20)
  })
})

describe('詰めた区間が隣と重ならない(同じ絵を2度使わない)', () => {
  it('ランダムな発話と場面の切れ目で、区間はいつも前の区間の終わりより後から始まる', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let trial = 0; trial < 3000; trial++) {
      const seconds = 60
      const activity = new Uint8Array(seconds * TURN_RATE)
      const speech: { start: number; end: number }[] = []
      for (let t = rand() * 3; t < seconds - 1;) {
        const len = 0.3 + rand() * 3
        speech.push({ start: t, end: Math.min(seconds, t + len) })
        activity.fill(
          1,
          Math.floor(t * TURN_RATE),
          Math.ceil(Math.min(seconds, t + len) * TURN_RATE)
        )
        t += len + rand() * 6
      }
      // 場面の切れ目は 10ms の格子に乗らない時刻
      const cuts = [0, ...[1, 2, 3].map((k) => k * 15 + rand() * 0.013), seconds]
      const ranges = cuts.slice(1).map((end, i) => ({ start: cuts[i], end, sceneId: `s${i}` }))
      const out = tightenRanges(ranges, activity, speech)
      for (let i = 1; i < out.length; i++)
        expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end - 1e-9)
    }
  })
})

describe('テロップは本編の終わりを越えない', () => {
  it('読み切れない枚を延ばすときも、終わりで止める', () => {
    const out = settleTelopTimes(
      [{ text: 'さいごのひとこと、ながめのセリフ', startTime: 9.5, endTime: 9.8 }],
      [10]
    )
    expect(out[0].endTime).toBeLessThanOrEqual(10)
  })
})

describe('段に積んだ発言テロップを、まとめて上げる(HUD を避ける)', () => {
  const style = { position: 'bottom', fontSize: 52 } as unknown as TextStyle
  const telops = [
    { text: 'さきにでた', style, startTime: 0, endTime: 4 },
    { text: 'かさなった', style, startTime: 1, endTime: 3 },
    {
      text: '手で置いた',
      style: { ...style, customPosition: { x: 0.3, y: 0.9 } },
      startTime: 1,
      endTime: 2
    }
  ]
  const H = 1080
  it('積んだものは段のテロップ、手で置いたものは違う', () => {
    const stacked = stackSimultaneousTelops(telops, H)
    expect(stackedBottomTelops(stacked, H)).toEqual([true, true, false])
  })
  it('一番下の段を指定の高さに置き、上の段はそこから積む', () => {
    const lifted = stackSimultaneousTelops(telops, H, { baseCenter: 0.7 })
    expect(lifted[0].style.customPosition).toEqual({ x: 0.5, y: 0.7 })
    expect(lifted[1].style.customPosition!.y).toBeLessThan(0.7 - 52 / H)
    expect(lifted[2].style.customPosition).toEqual({ x: 0.3, y: 0.9 })
  })
})

describe('静かな回でも「面白い所だけ」が空にならない', () => {
  it('点数の下限を越える場面が無ければ、点数の上位(4分の1)を残す', () => {
    const scenes: Scene[] = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      start: i * 60,
      end: i * 60 + 60,
      lines: [],
      speech: 30
    }))
    const judgements = scenes.map((s, i) => ({
      sceneId: s.id,
      score: 20 + i * 3,
      kind: 'normal' as const,
      reason: ''
    }))
    const sel = selectScenes(scenes, judgements, Infinity, undefined, 50)
    expect(sel.relaxed).toBe(true)
    expect(sel.kept).toEqual(['s6', 's7'])
    // 越える場面があれば、いつもどおり
    const some = judgements.map((j) => (j.sceneId === 's3' ? { ...j, score: 60 } : j))
    const normal = selectScenes(scenes, some, Infinity, undefined, 50)
    expect(normal.relaxed).toBeUndefined()
    expect(normal.kept).toEqual(['s3'])
  })
})

describe('BGM を声の下で下げる合図', () => {
  it('マイクと、全部入りのトラックは声。ゲーム音・カメラは声でない', () => {
    expect(carriesVoice({ kind: 'mic' })).toBe(true)
    expect(carriesVoice({ kind: 'audio', trackRole: 'mix' })).toBe(true)
    expect(carriesVoice({ kind: 'audio', trackRole: 'game' })).toBe(false)
    expect(carriesVoice({ kind: 'camera' })).toBe(false)
    expect(carriesVoice(undefined)).toBe(false)
  })
})

describe('発言テロップの見た目を替えても、顔を避けた置き場所は残す', () => {
  const look = (fontSize: number): TextStyle => defaultTextStyle({ fontSize, position: 'bottom' })
  const telop = (style: TextStyle, extra: Partial<TextOverlay> = {}): TextOverlay => ({
    id: 't',
    text: 'あ',
    startTime: 0,
    endTime: 1,
    style,
    source: 'auto',
    utteranceId: 'u1',
    ...extra
  })
  it('型から型へ: 上へ移した枚も新しい見た目になり、上のまま', () => {
    const moved = telop({ ...look(60), position: 'top' })
    const [out] = restyleSpeechTelops([moved], { style: look(60) }, { style: look(90) }, [])
    expect(out.style.fontSize).toBe(90)
    expect(out.style.position).toBe('top')
  })
  it('スタイルを直しても、テロップごとの置き場所(上・下・中央、傾き)は残す。自動・手で置いた枚とも同じ', () => {
    const def = { id: 'st', name: 'S', style: { ...look(80), rotation: 0 } }
    const auto = telop({ ...look(60), position: 'top' }, { styleId: 'st' })
    const manual = telop(
      { ...look(60), position: 'top', rotation: 15 },
      { id: 'm', styleId: 'st', source: undefined, utteranceId: undefined }
    )
    const [a, m] = restyleOverlays([auto, manual], [def])
    expect(a.style.fontSize).toBe(80)
    expect(a.style.position).toBe('top')
    expect(m.style.fontSize).toBe(80)
    expect(m.style.position).toBe('top')
    expect(m.style.rotation).toBe(15)
  })
})

describe('発言テロップの自由配置は、縦書きの見た目のときだけ使う', () => {
  const vertical = speechLook('tpl-speech-vertical', [])
  const standard = speechLook('tpl-speech-standard', [])
  const telop = (style: TextStyle): TextOverlay => ({
    id: 't',
    text: 'あ',
    startTime: 0,
    endTime: 1,
    style,
    source: 'auto',
    utteranceId: 'u1'
  })
  it('新しく作るとき: 縦書きは右端、横書きのスタイルに残った自由配置は使わない', () => {
    expect(speechTelopStyle(vertical.style).customPosition).toBeDefined()
    expect(
      speechTelopStyle({ ...standard.style, customPosition: { x: 0.5, y: 0.86 } }).customPosition
    ).toBeUndefined()
  })
  it('縦書き ⇄ 横書きを選び直すと、置き場所も見た目に合わせて替わる。動かした枚はそのまま', () => {
    const v = telop(speechTelopStyle(vertical.style))
    const [h] = restyleSpeechTelops([v], vertical, standard, [])
    expect(h.style.vertical).toBeFalsy()
    expect(h.style.customPosition).toBeUndefined()
    const [back] = restyleSpeechTelops([h], standard, vertical, [])
    expect(back.style.customPosition).toEqual(vertical.style.customPosition)
    const moved = telop({ ...speechTelopStyle(standard.style), customPosition: { x: 0.5, y: 0.7 } })
    const [m] = restyleSpeechTelops([moved], standard, vertical, [])
    expect(m.style.customPosition).toEqual({ x: 0.5, y: 0.7 })
  })
})

describe('縦書きから横書きへ選び直すと、声の重なった発言テロップを積み直す', () => {
  const vertical = speechLook('tpl-speech-vertical', [])
  const standard = speechLook('tpl-speech-standard', [])
  const at = (id: string, start: number, end: number): TextOverlay => ({
    id,
    text: 'あいう',
    startTime: start,
    endTime: end,
    style: speechTelopStyle(vertical.style),
    source: 'auto',
    utteranceId: id
  })
  it('重なった2枚は、1枚目が下・2枚目がその上の段', () => {
    const out = restyleSpeechTelops([at('a', 0, 3), at('b', 1, 4)], vertical, standard, [], 1080)
    expect(out[0].style.customPosition).toBeUndefined()
    expect(out[1].style.customPosition?.x).toBe(0.5)
    expect(out[1].style.customPosition!.y).toBeLessThan(0.9)
    // 横書きから縦書きへ戻すと、積んだ枚も右端の置き場所へ
    const back = restyleSpeechTelops(out, standard, vertical, [], 1080)
    expect(back[1].style.customPosition).toEqual(vertical.style.customPosition)
  })
})

describe('見た目を選び直して積み直すとき、ほかの話者の枚と同じ段に重ねない', () => {
  const standard = speechLook('tpl-speech-standard', [])
  const bigger = { style: { ...standard.style, fontSize: standard.style.fontSize + 20 } }
  const reg = [{ id: 'A-style', name: 'A', style: standard.style, speakers: ['A'] }]
  it('話者 A(スタイル割り当て)が下、B が上の段のまま', () => {
    const a: TextOverlay = {
      id: 'a',
      text: 'えーと',
      startTime: 0,
      endTime: 5,
      style: speechTelopStyle(standard.style),
      styleId: 'A-style',
      speaker: 'A',
      source: 'auto',
      utteranceId: 'ua'
    }
    const b: TextOverlay = {
      id: 'b',
      text: 'それな',
      startTime: 1,
      endTime: 4,
      style: speechTelopStyle(standard.style),
      speaker: 'B',
      source: 'auto',
      utteranceId: 'ub'
    }
    const [sa, sb] = stackSimultaneousTelops([a, b], 1080)
    const out = restyleSpeechTelops([sa, sb], standard, bigger, reg, 1080)
    expect(out[0].style.customPosition).toBeUndefined()
    expect(out[1].style.customPosition?.y).toBeLessThan(0.86)
    expect(out[1].style.fontSize).toBe(standard.style.fontSize + 20)
  })
})

describe('HUD を避けて上げた発言テロップも、見た目を替えたら同じ高さから積み直す', () => {
  const standard = speechLook('tpl-speech-standard', [])
  const bigger = { style: { ...standard.style, fontSize: standard.style.fontSize + 30 } }
  const t = (id: string, start: number, end: number): TextOverlay => ({
    id,
    text: 'あいうえお',
    startTime: start,
    endTime: end,
    style: speechTelopStyle(standard.style),
    source: 'auto',
    utteranceId: id
  })
  it('一番下の段は HUD を避けた高さのまま、上の段は大きくなった分だけ上へ', () => {
    const hud = stackSimultaneousTelops([t('a', 0, 4), t('b', 1, 3), t('c', 10, 12)], 1080, {
      baseCenter: 0.6
    })
    const out = restyleSpeechTelops(hud, standard, bigger, [], 1080)
    expect(out[0].style.customPosition).toEqual({ x: 0.5, y: 0.6 })
    expect(out[2].style.customPosition).toEqual({ x: 0.5, y: 0.6 })
    const gap = out[0].style.customPosition!.y - out[1].style.customPosition!.y
    // 2枚の中心の間は、大きくなった文字の高さより広い(重ならない)
    expect(gap * 1080).toBeGreaterThan(bigger.style.fontSize)
  })
})
