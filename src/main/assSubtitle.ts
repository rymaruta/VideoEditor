import type { TextOverlay, TextPosition, TranscriptWord } from '@shared/types'

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
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,sans-serif,${Math.round(height * 0.05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,3,3,0,5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const marginVOf = (position: TextPosition): number =>
    position === 'center' ? 0 : Math.round(height * 0.08)

  const lines = overlays.map((o) => {
    const style = o.style
    const alignCode = style.customPosition ? 5 : alignmentFor(style.position)
    const target = style.customPosition
      ? { x: style.customPosition.x * width, y: style.customPosition.y * height }
      : alignCode === 8
        ? { x: width / 2, y: height * 0.08 }
        : alignCode === 2
          ? { x: width / 2, y: height - height * 0.08 }
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

    const outlineTags = style.outline
      ? `\\3c${toAssColor(style.outlineColor)}\\bord${style.outlineWidth}`
      : '\\bord0'
    const shadowTag = `\\shad${style.shadow ? 2 : 0}`
    const backgroundTags = style.background
      ? `\\4c${toAssColor(style.backgroundColor)}\\4a${toAssAlpha(style.backgroundOpacity)}`
      : '\\4a&HFF&'
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

    const override = `{${positionTag}${rotationTag}\\fn${style.fontFamily}\\fs${style.fontSize}\\1c${primaryColor}${secondaryTag}\\b${bold}\\i${italic}${spacingTag}${outlineTags}${shadowTag}${backgroundTags}${animationTag}}`
    const text = useKaraoke
      ? buildKaraokeText(o.words!, o.startTime)
      : style.animation === 'typewriter'
        ? buildTypewriterText(o.text, 40, 50)
        : escapeAssText(o.text)
    return `Dialogue: 0,${toAssTime(o.startTime)},${toAssTime(o.endTime)},Default,,0,0,${marginVOf(style.position)},,${override}${text}`
  })

  return `${header}\n${lines.join('\n')}\n`
}
