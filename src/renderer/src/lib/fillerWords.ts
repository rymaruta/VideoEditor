const FILLER_WORDS = new Set([
  'えーと',
  'えっと',
  'ええと',
  'えーっと',
  'あの',
  'あのー',
  'あのう',
  'あのさ',
  'まあ',
  'まぁ',
  'なんか',
  'えー',
  'えーっ',
  'んー',
  'んーと',
  'その',
  'あー',
  'あーっと',
  'うーん',
  'うーんと',
  'まあその',
  'ま'
])

function normalize(text: string): string {
  return text.trim().replace(/[、。,.!?!?\s]/g, '')
}

export function isFillerWordText(text: string): boolean {
  return FILLER_WORDS.has(normalize(text))
}
