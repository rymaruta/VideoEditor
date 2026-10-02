import { describe, expect, it } from 'vitest'
import { listSpeakers, NO_SPEAKER_COLOR, speakerColor } from '../../src/shared/speaker'

describe('speakerColor', () => {
  it('話者が無ければ無地の色', () => {
    expect(speakerColor(undefined)).toBe(NO_SPEAKER_COLOR)
    expect(speakerColor('  ')).toBe(NO_SPEAKER_COLOR)
  })

  it('同じ名前なら常に同じ色(前後の空白は無視)', () => {
    expect(speakerColor('出演者A')).toBe(speakerColor(' 出演者A '))
    expect(speakerColor('出演者A')).not.toBe(NO_SPEAKER_COLOR)
  })
})

describe('listSpeakers', () => {
  it('多い順・同数は名前順で、空の話者は数えない', () => {
    const overlays = [
      { speaker: 'B' },
      { speaker: 'A' },
      { speaker: 'C' },
      { speaker: 'C' },
      { speaker: '' },
      {}
    ]
    expect(listSpeakers(overlays)).toEqual(['C', 'A', 'B'])
  })
})
