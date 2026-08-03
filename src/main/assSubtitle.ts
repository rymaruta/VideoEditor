import type { TextOverlay, TextPosition } from '@shared/types'

function toAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.round((seconds - Math.floor(seconds)) * 100)
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

function escapeAssText(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N')
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
    const alignment = alignmentFor(style.position)
    const primaryColor = toAssColor(style.color)
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
    }

    const override = `{\\an${alignment}\\fn${style.fontFamily}\\fs${style.fontSize}\\1c${primaryColor}\\b${bold}\\i${italic}${spacingTag}${outlineTags}${shadowTag}${backgroundTags}${animationTag}}`
    return `Dialogue: 0,${toAssTime(o.startTime)},${toAssTime(o.endTime)},Default,,0,0,${marginVOf(style.position)},,${override}${escapeAssText(o.text)}`
  })

  return `${header}\n${lines.join('\n')}\n`
}
