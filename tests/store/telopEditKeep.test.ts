import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import { useProjectStore } from '@renderer/store/projectStore'
import { defaultTextStyle } from '@shared/textStyle'
import { speechLook } from '@shared/telop/styles'
import type { TextOverlay } from '@shared/types'

/** 人が直した発言テロップは、作り直し・見た目の選び直しのあとも人の修正のまま */
const P = useProjectStore
const info = {
  anchorSourceId: 'A',
  sources: [{ id: 'A', name: 'カメラA', kind: 'camera' as const }],
  files: [{ assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 }]
}
const cut = {
  main: [{ assetId: 'camA', inPoint: 0, outPoint: 60, speed: 1 }],
  audio: [],
  duration: 60,
  spans: []
}
const setup = (): void => {
  P.getState().newProject()
  P.setState({ project: { ...P.getState().project, multicam: info, clips: [] } })
}
const auto = (
  u: string,
  start: number,
  style = defaultTextStyle(),
  extra: Partial<TextOverlay> = {}
): Omit<TextOverlay, 'id'> => ({
  text: `発言${u}`,
  startTime: start,
  endTime: start + 2,
  style,
  source: 'auto' as const,
  utteranceId: u,
  utteranceChunk: 0,
  ...extra
})
const find = (u: string): TextOverlay | undefined =>
  P.getState().project.textOverlays.find((o) => o.utteranceId === u)

describe('人が直した発言テロップを、作り直しで戻さない', () => {
  it('見た目を手で替えてスタイルから外した枚は、作り直してもスタイルにつなぎ直さない', () => {
    setup()
    const green = defaultTextStyle({ color: '#00ff00' })
    const incoming = [auto('u1', 1, green, { speaker: '太郎', styleId: 'S' })]
    P.getState().applyRoughCut(cut as never, incoming as never)
    const id = find('u1')!.id
    P.getState().updateTextOverlay(id, {
      style: { ...find('u1')!.style, color: '#ff0000' },
      styleId: undefined,
      speaker: undefined
    })
    P.getState().applyRoughCut(cut as never, incoming as never)
    expect(find('u1')?.styleId).toBeUndefined()
    expect(find('u1')?.speaker).toBeUndefined()
    P.getState().restyleTextOverlays([{ id: 'S', name: 'S', style: green }])
    expect(find('u1')?.style.color).toBe('#ff0000')
  })

  it('場面を落とした間に発言テロップの見た目を選び直しても、戻したときは新しい見た目', () => {
    setup()
    const a = speechLook('tpl-speech-standard', [])
    const b = speechLook('tpl-speech-yellow', [])
    P.getState().applyRoughCut(
      cut as never,
      [auto('u1', 1, a.style), auto('u2', 5, a.style)] as never
    )
    P.getState().updateTextOverlay(find('u1')!.id, { text: '直した文字' })
    // u1 の場面を落として作り直す
    P.getState().applyRoughCut(cut as never, [auto('u2', 5, a.style)] as never)
    expect(find('u1')).toBeUndefined()
    P.getState().restyleSpeechTelops(a, b, [])
    P.getState().applyRoughCut(
      cut as never,
      [auto('u1', 1, b.style), auto('u2', 5, b.style)] as never
    )
    expect(find('u1')?.text).toBe('直した文字')
    expect(find('u1')?.style.color).toBe(b.style.color)
  })
})
