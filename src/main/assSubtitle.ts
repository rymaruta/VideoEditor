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
Style: Default,sans-serif,${Math.round(height * 0.05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const marginVOf = (position: TextPosition): number =>
    position === 'center' ? 0 : Math.round(height * 0.08)

  const lines = overlays.map((o) => {
    const alignment = alignmentFor(o.style.position)
    const color = toAssColor(o.style.color)
    const bold = o.style.bold ? 1 : 0
    const outline = o.style.outline ? 3 : 0
    const override = `{\\an${alignment}\\fs${o.style.fontSize}\\c${color}\\b${bold}\\bord${outline}\\shad0}`
    return `Dialogue: 0,${toAssTime(o.startTime)},${toAssTime(o.endTime)},Default,,0,0,${marginVOf(o.style.position)},,${override}${escapeAssText(o.text)}`
  })

  return `${header}\n${lines.join('\n')}\n`
}
