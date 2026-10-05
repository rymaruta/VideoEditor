import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { PanelBoundary } from '@renderer/components/PanelBoundary'

/**
 * パネル1つぶんのエラーの受け止め役。落ちたパネルだけを「表示できませんでした」にして、
 * ほかのパネルを生かす。「もう一度表示する」でそのパネルだけ描き直す。
 * (テストは DOM 無しで走るので、受け止めたあとの状態と描く中身を直接確かめる)
 */
describe('PanelBoundary', () => {
  it('描画エラーを受け止め、パネル名と理由を出す。もう一度表示で元の中身に戻る', () => {
    const b = new PanelBoundary({ name: 'タイムライン', children: 'OK' })
    expect(b.render()).toBe('OK')
    b.state = PanelBoundary.getDerivedStateFromError(new Error('clips is undefined'))
    const shown = b.render() as ReactElement<{ role: string; children: ReactElement[] }>
    expect(shown.props.role).toBe('alert')
    const text = JSON.stringify(shown.props.children)
    expect(text).toContain('タイムライン')
    expect(text).toContain('clips is undefined')
    // setState は描画系が無いと効かないので、渡された更新を当てる
    b.setState = vi.fn((s) => Object.assign(b.state, s)) as unknown as typeof b.setState
    b.retry()
    expect(b.render()).toBe('OK')
  })

  it('落ちたことは記録に残す(原因を後から追えるように)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = new PanelBoundary({ name: 'テロップ', children: null })
    b.componentDidCatch(new Error('boom'), { componentStack: '\n at X' })
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('テロップ'),
      expect.any(Error),
      '\n at X'
    )
    spy.mockRestore()
  })
})
