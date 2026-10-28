import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { revealTelopDetail } from '../../src/renderer/src/lib/textOverlayPlacement'

/**
 * 試し編集 第2回の不具合 7: テロップの画面で一覧の行を選んでも、本文を直す欄が見える所に出なかった
 * (1920x1080 の窓で y=1854・高さ 0)。狭い区画では一覧と設定欄を縦に並べ、一覧の段の高さを
 * `minmax(min-content, 40%)` にしていたので、一覧の段が全部の行の高さまで伸び、設定欄を区画の外へ押し出していた
 */
describe('テロップの画面: 選んだテロップの本文の欄を見える所に出す', () => {
  const css = readFileSync(resolve(__dirname, '../../src/renderer/src/assets/main.css'), 'utf8')

  it('縦に並べたときの一覧には高さの上限がある(一覧の段が全部の行の高さまで伸びない)', () => {
    const start = css.indexOf('@container (max-width: 680px)')
    expect(start).toBeGreaterThan(0)
    // その @container の塊(波かっこの対応で取る)
    let depth = 0
    let end = css.indexOf('{', start)
    for (let i = end; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    const block = css.slice(start, end)
    expect(block).toContain('.telop-panel-body')
    const list = block.match(/\.telop-list\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(list).toMatch(/max-height:\s*\d/)
  })

  it('行を選んだら、本文の欄(textarea)を見える所へ送る', () => {
    const field = { scrollIntoView: vi.fn() }
    const pane = {
      querySelector: (q: string) => (q === 'textarea' ? field : null),
      scrollIntoView: vi.fn()
    }
    revealTelopDetail(pane as never)
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    // 本文の欄が無い(複数を選んだ)ときは設定欄そのもの
    const bare = { querySelector: () => null, scrollIntoView: vi.fn() }
    revealTelopDetail(bare as never)
    expect(bare.scrollIntoView).toHaveBeenCalled()
  })
})
