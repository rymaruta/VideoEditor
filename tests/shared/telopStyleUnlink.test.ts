import { describe, expect, it } from 'vitest'
import { restyleOverlays } from '@shared/telop/styles'
import { defaultTextStyle } from '@shared/textStyle'
import type { TextOverlay } from '@shared/types'

/** 手で見た目を変えてスタイルから外したテロップは、話者のスタイルでつなぎ直さない */
describe('restyleOverlays と手で外したテロップ', () => {
  const S = {
    id: 'S',
    name: '田中',
    style: defaultTextStyle({ color: '#00ff00' }),
    speakers: ['田中']
  }
  const overlay = (extra: Partial<TextOverlay>): TextOverlay => ({
    id: 'o',
    text: 'あ',
    startTime: 0,
    endTime: 1,
    style: defaultTextStyle({ color: '#ff0000' }),
    speaker: '田中',
    ...extra
  })
  it('外したテロップは手で付けた色のまま。外していないスタイル無しのテロップは話者のスタイルになる', () => {
    const [kept] = restyleOverlays([overlay({ styleUnlinked: true })], [S as never])
    expect(kept.style.color).toBe('#ff0000')
    expect(kept.styleId).toBeUndefined()
    const [linked] = restyleOverlays([overlay({})], [S as never])
    expect(linked.styleId).toBe('S')
  })
})
