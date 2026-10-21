import { describe, expect, it } from 'vitest'
import { normalizeLoadedProject } from '@renderer/store/projectStore'
import { autoTelopKey, type WithAutoSource } from '@shared/telop/manual'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project } from '@shared/types'

describe('発言テロップの元の部分(autoSource)の読み込み', () => {
  it('壊れた元の部分は外し、鍵を作っても落ちない。正しいものは残す', () => {
    const style = defaultTextStyle()
    const raw = {
      textOverlays: [
        {
          id: 'a',
          text: 'x',
          startTime: 0,
          endTime: 1,
          style,
          utteranceId: 'u1',
          utteranceChunk: 0,
          autoSource: { start: 'x', end: null }
        },
        {
          id: 'b',
          text: 'y',
          startTime: 1,
          endTime: 2,
          style,
          utteranceId: 'u1',
          utteranceChunk: 1,
          autoSource: { start: 1, end: 2, text: 'y' }
        }
      ],
      editedTelops: {
        'u:u1#0@0.000-1.000': { text: 'z', style, autoSource: { start: 0, end: 'bad', text: 'z' } }
      }
    } as unknown as Project
    const p = normalizeLoadedProject(raw)
    const [a, b] = p.textOverlays as (Project['textOverlays'][number] & WithAutoSource)[]
    expect(a.autoSource).toBeUndefined()
    expect(() => autoTelopKey(a)).not.toThrow()
    expect(autoTelopKey(a)).toBe('u:u1#0')
    expect(b.autoSource).toEqual({ start: 1, end: 2, text: 'y' })
    const rec = p.editedTelops!['u:u1#0@0.000-1.000'] as { autoSource?: unknown }
    expect(rec.autoSource).toBeUndefined()
  })
})
