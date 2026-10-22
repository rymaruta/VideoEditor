import { describe, expect, it } from 'vitest'
import { TELOP_TEMPLATES } from '@shared/telop/templates'
import { telopBounds } from '@shared/qc/telop'
import type { TextOverlay } from '@shared/types'

/** 全角も半角も文字の大きさの幅とみなす(重なりを大きめに見る) */
const ctx = {
  font: '',
  measureText(ch: string) {
    const s = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
    return { width: s * [...ch].length } as TextMetrics
  }
}
const canvas = { w: 1920, h: 1080 }

function box(id: string): { x: number; y: number; w: number; h: number } {
  const t = TELOP_TEMPLATES.find((x) => x.id === id)!
  const o: TextOverlay = { id, text: t.sample, startTime: 0, endTime: t.seconds, style: t.style() }
  return telopBounds(ctx, o, canvas)
}

function overlaps(a: string, b: string): boolean {
  const p = box(a)
  const q = box(b)
  return p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
}

/**
 * 同時に出しやすい演出テロップの型どうしが、既定の位置で重ならない。
 * 「実況者の名前」(出し続ける)と「進行状況(CHAPTER)」がどちらも左上、「ボス戦」と「絶叫」が
 * どちらも真ん中で、同時に使うと重なっていた
 */
describe('演出テロップの型の既定の位置', () => {
  it('実況者の名前と進行状況は重ならない', () => {
    expect(overlaps('tpl-people-streamer', 'tpl-play-progress')).toBe(false)
  })

  it('ボス戦と絶叫は重ならない', () => {
    expect(overlaps('tpl-play-boss', 'tpl-play-scream')).toBe(false)
  })

  it('動かした型は、下の発言テロップの帯(高さの 80% より下)に入らない', () => {
    for (const id of ['tpl-play-progress', 'tpl-play-boss']) {
      const b = box(id)
      expect(b.y + b.h, id).toBeLessThan(0.8)
      expect(b.y, id).toBeGreaterThan(0)
    }
  })
})
