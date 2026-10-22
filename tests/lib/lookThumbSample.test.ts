import { describe, expect, it } from 'vitest'
import { thumbSampleText } from '../../src/renderer/src/lib/lookThumb'
import { TELOP_KINDS } from '@shared/telop/kinds'
import { stripTelopMarkup } from '@shared/telop/render'

const width = (line: string): number =>
  [...line].reduce((t, c) => t + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0)

/**
 * スタイルの見た目一覧の見本。長い文を1行のまま描くと、枠の横幅に合わせて縮めるので
 * 文字が潰れて読めなかった(発言テロップ・方言の補足・ナレーションなど)
 */
describe('見た目一覧の見本の文', () => {
  it('発言テロップ・ナレーションの見本は短い文にする(2行に分けて大きく描ける)', () => {
    const sample = (id: string): string => TELOP_KINDS.find((k) => k.id === id)!.sample
    for (const id of ['speech', 'narration']) expect(width(sample(id)), id).toBeLessThanOrEqual(13)
    expect(thumbSampleText(sample('narration'), {})).toBe('一行は島の\n北端へ向かった。')
    expect(thumbSampleText(sample('speech'), {})).toBe('この水\nおいしい!')
  })

  it('長い1行は、読点・空白の後ろで短い行に分ける', () => {
    expect(thumbSampleText('一行が向かったのは、島の北端だった。', {})).toBe(
      '一行が向かったのは、\n島の北端だった。'
    )
    expect(thumbSampleText('ここの水 めっちゃおいしい!', {})).toBe('ここの水\nめっちゃおいしい!')
    expect(thumbSampleText("It's absolutely amazing!", {})).toBe("It's absolutely\namazing!")
    // 言葉の途中(漢字の言葉・送り仮名の前)では分けず、助詞・仮名から漢字への変わり目で分ける
    expect(thumbSampleText('本当においしい!', {})).toBe('本当に\nおいしい!')
    expect(thumbSampleText('いや今の絶対当たってたって', {})).toBe('いや今の\n絶対当たってたって')
    expect(thumbSampleText('ここで少し休憩しましょう', {})).toBe('ここで少し\n休憩しましょう')
  })

  it('短い文・縦書き・印のある行はそのまま', () => {
    expect(thumbSampleText('えっ ここ?', {})).toBe('えっ ここ?')
    expect(thumbSampleText('一行が向かったのは、島の北端だった。', { vertical: true })).toBe(
      '一行が向かったのは、島の北端だった。'
    )
    expect(thumbSampleText('A店 **1,200円**  vs  B店 **980円**', {})).toBe(
      'A店 **1,200円**  vs  B店 **980円**'
    )
  })

  it('印の無い見本は、どれも見本の1行が全角 12 文字ほどに収まり、文字は1つも落とさない', () => {
    for (const k of TELOP_KINDS) {
      const style = k.style()
      const out = thumbSampleText(k.sample, style)
      expect(out.replace(/\s/g, ''), k.id).toBe(k.sample.replace(/\s/g, ''))
      if (style.vertical || /[*_[\]{}~`|<>]/.test(k.sample)) continue
      for (const line of stripTelopMarkup(out).split('\n'))
        expect(width(line), `${k.id}: ${line}`).toBeLessThanOrEqual(12)
    }
  })
})
