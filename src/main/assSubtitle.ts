import type { TextOverlay, TextPosition, TranscriptWord } from '@shared/types'
import { textMarginHPx, textMarginVPx } from '@shared/textStyle'

function toAssTime(seconds: number): string {
  // A negative or non-finite time (an older project file, a hand-edited .veproj)
  // would render as "-1:-1:-3.00", which libass cannot parse — the subtitle line
  // is then dropped or misplaced. Clamp instead of emitting a broken timestamp.
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const cs = Math.round((safe - Math.floor(safe)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function alignmentFor(position: TextPosition): number {
  switch (position) {
    case 'top':
      return 8
    case 'bottom':
      return 2
    default:
      return 5
  }
}

function toAssColor(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

function toAssAlpha(opacity: number): string {
  const alpha = Math.round((1 - opacity) * 255)
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}&`
}

// How far the background box extends past the text, in the same units as \bord.
const BOX_PADDING = 6

// ASS has no escape for a literal backslash — libass reads \N, \n and \h as control
// sequences — so a caption typed as "C:\Nintendo" rendered as "C:" + a line break +
// "intendo": the N was swallowed and an unwanted line appeared. A zero-width space
// after the backslash breaks the sequence without changing what the viewer sees.
// This MUST run before the brace/newline escapes, otherwise it would mangle the
// backslashes those escapes introduce.
function escapeAssBackslash(text: string): string {
  return text.replace(/\\/g, '\\\u200B')
}

function escapeAssText(text: string): string {
  return escapeAssBackslash(text).replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N')
}

/**
 * 折り返しの見積もりに使う1文字の幅(フォントサイズに対する比)。
 * 全角(CJK・かな・全角記号)はおよそ1em、半角はおよそ0.5em。
 */
function emWidthOf(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  const wide =
    (code >= 0x1100 && code <= 0x115f) || // ハングル字母
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首〜漢字・かな
    (code >= 0xac00 && code <= 0xd7a3) || // ハングル
    (code >= 0xf900 && code <= 0xfaff) || // CJK 互換漢字
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 互換記号
    (code >= 0xff00 && code <= 0xff60) || // 全角英数・記号
    (code >= 0xffe0 && code <= 0xffe6)
  return wide ? 1 : 0.5
}

/**
 * **libass が折り返せない並びを、こちらで折り返す。**
 *
 * libass は空白でしか行を分けない。日本語のように空白の無い文章は
 * **1行のまま伸び続け、フレームの外へはみ出して両端が切れる**
 * (実測: 全角200文字のテロップが 1280x720 の出力で1行になり、
 *  インクが左端 0% 〜 右端 100% まで届いて文字が読めなくなっていた。
 *  画面側は CSS が文字単位で折り返すので5行で収まっている)。
 * ゼロ幅空白(U+200B)を挟んでも libass は折り返さないことを実測で確認済み。
 *
 * 幅は**見積もり**で決める。main プロセスにはフォントの字送りを測る手段が無いため、
 * 全角1em・半角0.5em として数える。実フォントより少し広めに見積もるので、
 * **切れるより手前で折り返す**側に倒れる。
 * 空白で区切られた並び(英文など)は libass 自身が折り返せるので、
 * **1つの塊が入り切らないときだけ**その塊の中を割る——こちらで先回りして割ると、
 * libass の折り返しと二重にかかって不自然な位置で切れる。
 */
export function wrapAssLines(text: string, maxEmPerLine: number): string[] {
  if (!Number.isFinite(maxEmPerLine) || maxEmPerLine <= 0) return text.split('\n')
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    // 空白で分けられる塊ごとに見て、入り切らない塊だけを文字単位で割る
    let current = ''
    let currentEm = 0
    const flush = (): void => {
      out.push(current)
      current = ''
      currentEm = 0
    }
    for (const chunk of rawLine.split(/(\s+)/)) {
      if (chunk === '') continue
      const chars = [...chunk]
      const chunkEm = chars.reduce((sum, ch) => sum + emWidthOf(ch), 0)
      // 塊そのものが1行に入らない = libass では絶対に折り返せない並び
      if (chunkEm > maxEmPerLine) {
        for (const ch of chars) {
          const em = emWidthOf(ch)
          if (currentEm + em > maxEmPerLine && current !== '') flush()
          current += ch
          currentEm += em
        }
        continue
      }
      if (currentEm + chunkEm > maxEmPerLine && current.trim() !== '') {
        flush()
        if (/^\s+$/.test(chunk)) continue // 行頭の空白は落とす
      }
      current += chunk
      currentEm += chunkEm
    }
    out.push(current)
  }
  return out
}

function buildTypewriterText(text: string, charDelayMs: number, revealMs: number): string {
  const lines = text.split('\n')
  let index = 0
  const rendered = lines.map((line) =>
    [...line]
      .map((ch) => {
        const start = index * charDelayMs
        index += 1
        // A raw backslash here is worse than in plain text: the next thing emitted
        // is an override block, so "\" + "{\alpha..." would escape that brace and
        // dump the tag on screen as literal text.
        const escaped = ch === '{' ? '\\{' : ch === '}' ? '\\}' : escapeAssBackslash(ch)
        return `{\\alpha&HFF&\\t(${start},${start + revealMs},\\alpha&H00&)}${escaped}`
      })
      .join('')
  )
  return rendered.join('\\N')
}

function buildKaraokeText(words: TranscriptWord[], dialogueStart: number): string {
  let cursor = dialogueStart
  return words
    .map((w) => {
      const gap = w.start - cursor
      const gapTag = gap > 0.01 ? `{\\k${Math.max(1, Math.round(gap * 100))}}` : ''
      const durCentis = Math.max(1, Math.round((w.end - w.start) * 100))
      cursor = w.end
      return `${gapTag}{\\k${durCentis}}${escapeAssText(w.text)}`
    })
    .join('')
}

export function buildAssContent(overlays: TextOverlay[], width: number, height: number): string {
  // 左右の余白は画面(CSS)と同じ比から出す。ここに数字を書くと、片方だけ動いて
  // 「画面では折り返るのに書き出しでは1行」のような食い違いに戻る。
  const marginH = Math.round(textMarginHPx(width))
  const textAreaWidth = Math.max(1, width - marginH * 2)
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,sans-serif,${Math.round(height * 0.05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,3,0,5,${marginH},${marginH},40,1
Style: Boxed,sans-serif,${Math.round(height * 0.05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,3,3,0,5,${marginH},${marginH},40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const marginVOf = (position: TextPosition): number =>
    position === 'center' ? 0 : Math.round(textMarginVPx(height))

  const lines = overlays.map((o) => {
    const style = o.style
    const alignCode = style.customPosition ? 5 : alignmentFor(style.position)
    const target = style.customPosition
      ? { x: style.customPosition.x * width, y: style.customPosition.y * height }
      : alignCode === 8
        ? { x: width / 2, y: textMarginVPx(height) }
        : alignCode === 2
          ? { x: width / 2, y: height - textMarginVPx(height) }
          : { x: width / 2, y: height / 2 }

    let positionTag: string
    if (style.animation === 'slideInUp' || style.animation === 'slideInDown') {
      const offset = Math.round(height * 0.06)
      const yFrom = style.animation === 'slideInUp' ? target.y + offset : target.y - offset
      positionTag = `\\an${alignCode}\\move(${Math.round(target.x)},${Math.round(yFrom)},${Math.round(target.x)},${Math.round(target.y)},0,350)`
    } else if (style.customPosition) {
      positionTag = `\\an5\\pos(${Math.round(target.x)},${Math.round(target.y)})`
    } else {
      positionTag = `\\an${alignCode}`
    }

    const rotationTag = style.rotation ? `\\frz${-style.rotation}` : ''
    const useKaraoke = style.wordHighlight && !!o.words && o.words.length > 0
    const primaryColor = toAssColor(useKaraoke ? style.highlightColor : style.color)
    const secondaryTag = useKaraoke ? `\\2c${toAssColor(style.color)}` : ''
    const bold = style.bold ? 1 : 0
    const italic = style.italic ? 1 : 0

    // BorderStyle=1 draws \bord as an outline in \3c and \shad as a shadow in \4c.
    // The Default style used to be BorderStyle=3 (opaque box), which reads the very
    // same tags as a *box* — so the default caption (outline on, background off)
    // exported as white text inside a black box, a background box exported with no
    // box at all, and \4a&HFF& silently made every shadow invisible too.
    const outlineTags = style.outline
      ? `\\3c${toAssColor(style.outlineColor)}\\bord${style.outlineWidth}`
      : '\\bord0'
    const shadowTags = style.shadow ? '\\shad2\\4c&H00000000\\4a&H60&' : '\\shad0'
    const spacingTag = style.letterSpacing ? `\\fsp${style.letterSpacing}` : ''

    let animationTag = ''
    if (style.animation === 'fadeIn') {
      animationTag = '\\fad(300,0)'
    } else if (style.animation === 'popIn') {
      animationTag = '\\fscx60\\fscy60\\t(0,200,\\fscx100\\fscy100)'
    } else if (style.animation === 'bounce') {
      animationTag =
        '\\fscx30\\fscy30\\t(0,250,\\fscx115\\fscy115)\\t(250,350,\\fscx92\\fscy92)\\t(350,500,\\fscx100\\fscy100)'
    }

    const common = `${positionTag}${rotationTag}\\fn${style.fontFamily}\\fs${style.fontSize}\\b${bold}\\i${italic}${spacingTag}`
    const override = `{${common}\\1c${primaryColor}${secondaryTag}${outlineTags}${shadowTags}${animationTag}}`
    // 1行に入る文字数は「文字入れできる幅 ÷ 文字サイズ」。`\\pos` を使うテロップは
    // 余白の指定が効かないので、枠の幅そのものから同じ比で引く。
    const fontSize = Number.isFinite(style.fontSize) && style.fontSize > 0 ? style.fontSize : 1
    const maxEmPerLine = (style.customPosition ? width - marginH * 2 : textAreaWidth) / fontSize
    const wrapped = wrapAssLines(o.text, maxEmPerLine)
    const text = useKaraoke
      ? buildKaraokeText(o.words!, o.startTime)
      : style.animation === 'typewriter'
        ? buildTypewriterText(wrapped.join('\n'), 40, 50)
        : wrapped.map(escapeAssText).join('\\N')

    const start = toAssTime(o.startTime)
    const end = toAssTime(o.endTime)
    const marginV = marginVOf(style.position)
    if (!style.background) {
      return `Dialogue: 0,${start},${end},Default,,0,0,${marginV},,${override}${text}`
    }

    // A box and an outline cannot come from the same ASS line: BorderStyle is a style
    // property and \bord means "box padding" under BorderStyle=3. So the box is its own
    // line underneath — same font, position and animation so the two move together —
    // carrying invisible text (\1a&HFF&) purely to size the box. The visible text then
    // draws on the layer above and keeps its outline.
    const boxOverride =
      `{${common}\\1a&HFF&\\3c${toAssColor(style.backgroundColor)}` +
      `\\3a${toAssAlpha(style.backgroundOpacity)}\\bord${BOX_PADDING}\\shad0${animationTag}}`
    return [
      `Dialogue: 0,${start},${end},Boxed,,0,0,${marginV},,${boxOverride}${wrapped.map(escapeAssText).join('\\N')}`,
      `Dialogue: 1,${start},${end},Default,,0,0,${marginV},,${override}${text}`
    ].join('\n')
  })

  return `${header}\n${lines.join('\n')}\n`
}
