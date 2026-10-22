import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { TERM_RULES } from '../../src/renderer/src/lib/terms'

/**
 * デザインの決まり(tokens.css)と言い回し(lib/terms.ts)を、新しい直書きで崩さないための検査。
 * stylelint の代わりの簡単な検査: 色の直書き・決まりに無い文字の大きさ・使わない言い回しを数える。
 */
const ROOT = join(__dirname, '../../src/renderer/src')

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p, ext)
    return ext.test(name) ? [p] : []
  })
}

/** コメントを空白にする(行の位置は保つ) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g

/**
 * 色の直書きが残っている数の上限(データの色・まだ名前の無い淡い光など)。
 * 減ったら下げる。増やさない — 新しい色は tokens.css に名前を足して var() で使う
 */
const COLOR_BUDGET: Record<string, number> = {
  'assets/autoEditG3.css': 22,
  'assets/dialogsG3.css': 8,
  'assets/graphite3.css': 28,
  'assets/main.css': 22,
  'components/gradientEditor.css': 4,
  'components/rangeAutoEdit.css': 5
}

describe('デザインの決まり(CSS)', () => {
  const files = walk(ROOT, /\.css$/).filter(
    (f) => !f.endsWith('tokens.css') && !f.endsWith('telopFonts.css') && !f.endsWith('uiFonts.css')
  )

  it('色の直書きを増やさない(tokens.css の名前を使う)', () => {
    const over: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, '/')
      const n = (stripComments(readFileSync(f, 'utf8')).match(COLOR) ?? []).length
      const budget = COLOR_BUDGET[rel] ?? 0
      if (n > budget) over.push(`${rel}: ${n} 個(上限 ${budget})`)
    }
    expect(over).toEqual([])
  })

  it('文字の大きさは段の名前(var(--ve-fs-*))だけ', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      src.split('\n').forEach((line, i) => {
        if (/font-size:\s*[\d.]+px/.test(line))
          bad.push(`${relative(ROOT, f)}:${i + 1} ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('動きの時間は tokens の名前(var(--ve-dur-*))', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const m of src.matchAll(/transition:([^;{}]+);/g)) {
        if (/\d*\.?\d+m?s\b/.test(m[1].replace(/var\([^)]*\)/g, '')) && !/\b0s\b/.test(m[1]))
          bad.push(`${relative(ROOT, f)}: ${m[1].trim()}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('旧い名前(--text-1・--bg-elevated・--accent 等)を使わない', () => {
    const OLD = new RegExp(
      'var\\(--(' +
        [
          'text-[123]',
          'text-dim',
          'bg',
          'bg-elevated(-[23])?',
          'border(-soft)?',
          'accent(-[12]|-ink|-soft)?',
          'on-accent',
          'danger(-soft|-ink)?',
          'success',
          'warn',
          'radius-(sm|md|lg)',
          'shadow-float',
          'font-(sans|mono)',
          've-panel(-top|-fill|-shadow)?',
          've-field',
          've-raised(-fill|-hover)?',
          've-line(-field|-control|-control-hover|-strong)?',
          've-text',
          've-accent(-[a-z]+)?',
          've-ok(-[a-z]+)?',
          've-on-accent',
          've-radius-(clip|control|card)',
          've-ease',
          've-dur',
          've-trk-(video|telop|audio)(-line|-ink)?',
          'g3-(mono|line|select-ring)'
        ].join('|') +
        ')\\)'
    )
    const bad: string[] = []
    for (const f of [...files, ...walk(ROOT, /\.tsx?$/)]) {
      const src = stripComments(readFileSync(f, 'utf8'))
      src.split('\n').forEach((line, i) => {
        const m = line.match(OLD)
        if (m) bad.push(`${relative(ROOT, f)}:${i + 1} ${m[0]}`)
      })
    }
    expect(bad).toEqual([])
  })
})

describe('言い回し(lib/terms.ts)', () => {
  it('画面の字に使わない言い方が無い', () => {
    const files = [
      ...walk(join(ROOT, 'components'), /\.tsx$/),
      join(ROOT, 'App.tsx'),
      join(__dirname, '../../src/shared/appMenu.ts')
    ]
    const bad: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'))
          return
        for (const r of TERM_RULES) {
          if (r.avoid.test(line) && !(r.allow && r.allow.test(line)))
            bad.push(`${relative(ROOT, f)}:${i + 1} 「${r.use}」に: ${t.slice(0, 60)}`)
        }
      })
    }
    expect(bad).toEqual([])
  })
})
