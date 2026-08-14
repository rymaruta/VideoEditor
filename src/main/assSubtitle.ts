import type { TextOverlay, TextPosition, TranscriptWord } from '@shared/types'
import { textBoxPaddingPx, textMarginHPx, textMarginVPx } from '@shared/textStyle'
import { karaokeWords } from '@shared/captionWords'

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

/** ASS に書く小数。0.4×文字サイズのような値がそのまま長い小数にならないよう2桁で丸める */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function escapeAssText(text: string): string {
  return escapeAssBackslash(text).replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N')
}

/** 折り返しに使う1文字あたりの幅(どれもフォントサイズに対する比) */
export interface WrapMetrics {
  /**
   * 全角1文字の送り幅。**libass に実際に描かせて測った値**を渡す
   * (`fontMetrics.wideAdvanceEm`)。測れなかったときだけ既定の 1 に倒す——
   * 1 は「実フォントより広め」に倒した見積もりで、切れるより手前で折る側。
   */
  wideEm: number
  /**
   * 半角1文字の送り幅。ここは測っていない: 半角の送り幅は文字ごとに大きく違い
   * (実測 `a` 0.526em / `0` 0.547em / `W` 0.849em)、1つの数字では表せない。
   * 一方で**空白のある並びは libass 自身が折り返せる**ので、多少ずれても
   * フレームからはみ出すところまでは行かない。狭めの 0.5 のままにしてある。
   */
  narrowEm: number
  /**
   * 1文字ごとに足される字間(`\fsp` = `letterSpacing` ÷ 文字サイズ)。
   * **入れ忘れると、字間を広げたテロップだけが枠からはみ出す。**
   * 今までは全角を 1em と多めに見積もっていたぶんで隠れていたが、
   * 実測値(この環境では 0.812em)を使うと余裕が無くなるので必ず数に入れる。
   */
  spacingEm: number
}

export const DEFAULT_WRAP_METRICS: WrapMetrics = { wideEm: 1, narrowEm: 0.5, spacingEm: 0 }

/**
 * 送り幅の表を引くキー。太字は別のフォントとして扱う(実測で半角は
 * `a` 0.526em → 太字 0.580em と変わる)。**測る側と引く側で必ずこの関数を通す**——
 * 片方だけキーの作り方が変わると、黙って引けなくなって見積もりに戻る。
 */
export function fontMetricsKey(fontFamily: string, bold: boolean): string {
  return `${fontFamily}|${bold ? 'b' : ''}`
}

function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) || // ハングル字母
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首〜漢字・かな
    (code >= 0xac00 && code <= 0xd7a3) || // ハングル
    (code >= 0xf900 && code <= 0xfaff) || // CJK 互換漢字
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 互換記号
    (code >= 0xff00 && code <= 0xff60) || // 全角英数・記号
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

/** 折り返しの見積もりに使う1文字の幅(フォントサイズに対する比)。 */
function emWidthOf(ch: string, m: WrapMetrics): number {
  return (isWideChar(ch) ? m.wideEm : m.narrowEm) + m.spacingEm
}

/** 外から来た数字をそのまま掛け算に入れない(NaN が1つ混ざると全部の幅が NaN になる) */
function sanitizeMetrics(m?: Partial<WrapMetrics>): WrapMetrics {
  const pick = (v: number | undefined, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback
  return {
    wideEm: pick(m?.wideEm, DEFAULT_WRAP_METRICS.wideEm, 0.1, 5),
    narrowEm: pick(m?.narrowEm, DEFAULT_WRAP_METRICS.narrowEm, 0.05, 5),
    spacingEm: pick(m?.spacingEm, DEFAULT_WRAP_METRICS.spacingEm, 0, 5)
  }
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
 * 幅は `metrics` で決める。**全角の送り幅は libass 自身に描かせて実測した値**を渡すこと
 * (`fontMetrics.wideAdvanceEm`)。渡さなければ従来どおり全角1em・半角0.5emの見積もりで、
 * 実フォントより広めなので**切れるより手前で折り返す**側に倒れる。
 * 空白で区切られた並び(英文など)は libass 自身が折り返せるので、
 * **1つの塊が入り切らないときだけ**その塊の中を割る——こちらで先回りして割ると、
 * libass の折り返しと二重にかかって不自然な位置で切れる。
 */
export function wrapAssLines(
  text: string,
  maxEmPerLine: number,
  metrics?: Partial<WrapMetrics>
): string[] {
  if (!Number.isFinite(maxEmPerLine) || maxEmPerLine <= 0) return text.split('\n')
  const m = sanitizeMetrics(metrics)
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
      const chunkEm = chars.reduce((sum, ch) => sum + emWidthOf(ch, m), 0)
      // 塊そのものが1行に入らない = libass では絶対に折り返せない並び
      if (chunkEm > maxEmPerLine) {
        for (const ch of chars) {
          const em = emWidthOf(ch, m)
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

/**
 * 単語ハイライト(カラオケ)のテキストを組む。**ここでも折り返す。**
 *
 * `\k` を挟んだテキストは `wrapAssLines` を通せない(タグごと数えてしまう)ので、
 * この関数の中で幅を数えながら `\N` を入れる。**通していなかったせいで、
 * 単語ハイライトを付けたテロップだけが1行のまま伸びてフレームの外へ出ていた**
 * (実測: 全角47文字・文字サイズ40 を 1080x1920 に焼くと、字面が左端 0.0% 〜
 *  右端 100.0% まで届いて両端が切れる。ハイライト無しなら 14.4%〜85.8% の2行)。
 * 自動テロップとAIショートの発言テロップは既定でハイライト付きなので、
 * **文字起こしから作ったテロップは全部これを踏んでいた**。
 *
 * `\k` は `\N` をまたいでも効き続けるので、折り返しても色の付く順序と時刻は変わらない。
 * 折るのは単語の頭が基本で、1単語が1行に入らないときだけ単語の中で折る。
 *
 * 背景箱は別の Dialogue 行に同じ文字を書いて大きさを決めているので、
 * **箱が使う行分けもここで返す**(別々に折ると箱と本文の行が食い違う)。
 */
function buildKaraokeText(
  words: TranscriptWord[],
  dialogueStart: number,
  maxEmPerLine: number,
  metrics: WrapMetrics
): { text: string; lines: string[] } {
  const wrapAt = Number.isFinite(maxEmPerLine) && maxEmPerLine > 0 ? maxEmPerLine : Infinity
  let cursor = dialogueStart
  let lineEm = 0
  const parts: string[] = []
  const lines: string[] = ['']
  const newLine = (): void => {
    lines.push('')
    lineEm = 0
  }
  for (const w of words) {
    const gap = w.start - cursor
    const gapTag = gap > 0.01 ? `{\\k${Math.max(1, Math.round(gap * 100))}}` : ''
    const durCentis = Math.max(1, Math.round((w.end - w.start) * 100))
    cursor = w.end
    const chars = [...w.text]
    const wordEm = chars.reduce((sum, ch) => sum + emWidthOf(ch, metrics), 0)
    let prefix = ''
    if (lineEm > 0 && lineEm + wordEm > wrapAt && wordEm <= wrapAt) {
      prefix = '\\N'
      newLine()
    }
    let body = ''
    for (const ch of chars) {
      const em = emWidthOf(ch, metrics)
      if (lineEm > 0 && lineEm + em > wrapAt) {
        body += '\\N'
        newLine()
      }
      body += escapeAssText(ch)
      lines[lines.length - 1] += ch
      lineEm += em
    }
    parts.push(`${prefix}${gapTag}{\\k${durCentis}}${body}`)
  }
  return { text: parts.join(''), lines }
}

export function buildAssContent(
  overlays: TextOverlay[],
  width: number,
  height: number,
  /**
   * 全角1文字の送り幅(フォントサイズに対する比)を、フォントごとに引ける表。
   * `fontMetrics` が **libass に実際に描かせて測った値**を入れる。
   * 引けなかったフォントは従来どおりの見積もり(1em)に倒れる。
   * **1つの数字で代表させない**——フォントを混ぜたプロジェクトで、別のフォントの
   * 送り幅を当てはめると、狭いほうへ外したときに枠からはみ出す。
   */
  wideEmByFont?: ReadonlyMap<string, number>
): string {
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
    // 単語ハイライトは**単語列がまだ本文を綴っているときだけ**。打ち直された本文を
    // 無視して古い単語を焼かないための判定で、画面側と同じ関数を通す(理由は karaokeWords)。
    const karaokeSource = karaokeWords(o)
    const useKaraoke = karaokeSource !== null
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
    // `\fsp` は1文字ごとに幅を足す。数に入れないと、字間を広げたテロップだけが
    // 枠からはみ出す(全角を多めに見積もっていたぶんで今まで隠れていた)。
    const spacingEm = style.letterSpacing ? style.letterSpacing / fontSize : 0
    const wideEm = wideEmByFont?.get(fontMetricsKey(style.fontFamily, style.bold))
    const metrics = sanitizeMetrics({ wideEm, spacingEm })
    const wrapped = wrapAssLines(o.text, maxEmPerLine, metrics)
    // カラオケも同じ幅で折り返す。折らないと単語ハイライト付きのテロップだけが
    // 1行のまま伸びて枠の外へ出る(理由は buildKaraokeText)。
    const karaoke = karaokeSource
      ? buildKaraokeText(karaokeSource, o.startTime, maxEmPerLine, metrics)
      : null
    const text = karaoke
      ? karaoke.text
      : style.animation === 'typewriter'
        ? buildTypewriterText(wrapped.join('\n'), 40, 50)
        : wrapped.map(escapeAssText).join('\\N')
    // 背景箱は本文と**同じ行分け**で組む。別々に折ると箱の行と本文の行が食い違う。
    const boxLines = karaoke ? karaoke.lines : wrapped

    const start = toAssTime(o.startTime)
    const end = toAssTime(o.endTime)
    const marginV = marginVOf(style.position)
    const boxPadding = textBoxPaddingPx(style.fontSize)
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
      `\\3a${toAssAlpha(style.backgroundOpacity)}` +
      // 箱の余白は**文字サイズに対する比**。`\bord6` の決め打ちだと、文字を大きくしても
      // 箱だけ太らず画面と食い違う。`\bord` は上下左右が同じ値になるので、
      // 軸ごとに指定できる `\xbord`/`\ybord` を使う。
      `\\xbord${round2(boxPadding.x)}\\ybord${round2(boxPadding.y)}\\shad0${animationTag}}`
    return [
      `Dialogue: 0,${start},${end},Boxed,,0,0,${marginV},,${boxOverride}${boxLines.map(escapeAssText).join('\\N')}`,
      `Dialogue: 1,${start},${end},Default,,0,0,${marginV},,${override}${text}`
    ].join('\n')
  })

  return `${header}\n${lines.join('\n')}\n`
}
