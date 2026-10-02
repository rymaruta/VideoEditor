import type { FontFamily, TelopStroke, TextAnimation, TextPosition, TextStyle } from './types'

/**
 * テロップの上下の余白(**枠の高さ**に対する比)。
 *
 * 書き出し(ASS の MarginV)とプレビュー(CSS の `top`/`bottom`)が**同じ数字**を使うための
 * 共通の置き場。書き写すと片方だけ育って黙ってズレる——実際、書き出しは上下とも 8% なのに
 * CSS だけ `.overlay-top { top: 8% }` / `.overlay-bottom { bottom: 10% }` と**下だけ 10%**に
 * なっていた。既定のテロップ位置が `bottom` なので、**既定のまま使うと必ず踏む**。
 * 実測(1280x720・既定スタイル): 画面では文字の下端が枠下から 10.59% なのに、
 * 書き出しでは 8.06% に焼かれていた(上と中央はズレていない)。
 *
 * `top`/`bottom` の `%` は親の**高さ**基準なので、高さ基準の書き出し側と単位は揃っている。
 * ズレていたのは基準ではなく数字そのものだった。
 */
export const TEXT_MARGIN_V_RATIO = 0.08

/** 枠の高さから上下の余白(px)を出す。書き出し側はこれを丸めて MarginV に入れる。 */
export function textMarginVPx(frameHeight: number): number {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return 0
  return frameHeight * TEXT_MARGIN_V_RATIO
}

/**
 * テロップの左右の余白(**枠の幅**に対する比)。折り返す幅はこれで決まる。
 *
 * 画面は CSS の `left`/`right`、書き出しは ASS の MarginL/R と、**書く場所が違うだけで
 * 同じ規則**なので、数字はここ1つに置く(縦の余白と同じ理由)。
 */
export const TEXT_MARGIN_H_RATIO = 0.05

/** 枠の幅から左右の余白(px)を出す。書き出し側はこれを丸めて MarginL/R に入れる。 */
export function textMarginHPx(frameWidth: number): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return 0
  return frameWidth * TEXT_MARGIN_H_RATIO
}

/**
 * 登場アニメーション「下から出る」「上から出る」が動く距離(**枠の高さ**に対する比)。
 *
 * 書き出しは ASS の `\move`(キャンバス高の 6%)、画面は CSS の `@keyframes` と、
 * 上下左右の余白と同じく**書く場所が違うだけで同じ規則**なので、数字はここ1つに置く。
 * 画面側だけ `translateY(40px)` と**プレビュー枠のピクセルで固定**されていたため、
 * 枠の大きさが変わるたびに書き出しとの比が動き、既定のレイアウトでは
 * **2.8倍**遠くから飛び込んでいた。しかも `.preview-frame` は `overflow: hidden` なので、
 * 出だしはテロップが**枠の外に出て1画素も見えない**(実測: 枠 132.97x236.38 の 9:16 で
 * 移動距離が画面 40px = 枠高の **16.92%** に対し書き出しは **5.97%**。
 * 画面写真の枠の中の白い画素は開始時点で **0個**、書き出しは同じ時点で枠の中に収まっている)。
 */
export const TEXT_SLIDE_OFFSET_RATIO = 0.06

/**
 * 枠の高さから登場アニメーションの移動距離(px)を出す。単位は**渡した高さと同じ**
 * (書き出しなら ASS キャンバスのピクセル、画面ならプレビュー枠のピクセル)。
 * **画面側では整数に丸めないこと**——`translate` は小数pxを受け付けるので、
 * 丸めると縮小率が高いときに丸めのほうが誤差の主因になる(縁取りと同じ理由)。
 */
export function textSlideOffsetPx(frameHeight: number): number {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return 0
  return frameHeight * TEXT_SLIDE_OFFSET_RATIO
}

/**
 * 登場アニメーションの長さ(ミリ秒)。
 *
 * 画面は CSS の `animation`、書き出しは ASS の `\move` / `\t` / `\fad` と**書く場所が
 * 違うだけで同じ規則**なので、数字はここ1つに置く(余白・飛び込む距離と同じ理由)。
 * `none` と `typewriter` は「1枚まるごとの登場」を持たない(後者は文字ごとに出る)ので 0。
 */
export const TEXT_ANIMATION_MS: Record<TextAnimation, number> = {
  none: 0,
  fadeIn: 300,
  popIn: 200,
  slideInUp: 350,
  slideInDown: 350,
  bounce: 500,
  typewriter: 0
}

/**
 * 登場時に**透明から不透明へ変わる**長さ(ミリ秒)。0 ならフェードしない。
 *
 * 画面の `@keyframes` は「下から出る」「上から出る」で `opacity: 0 → 1` を全体に、
 * 「弾む」では前半(50% = 250ms)で掛けている。書き出しには `\fad` が
 * **`fadeIn` にしか無かった**ので、同じ演出なのに画面だけふわっと出ていた。
 * (実測・下から出る: 開始時点の不透明度が画面 **0** / 87.5ms で **0.409** /
 *  175ms で **0.802** なのに、書き出しは同じ3点とも**完全に不透明**)
 * 拡大だけの `popIn` は画面側も透明度を触らないので 0。
 */
export const TEXT_FADE_IN_MS: Record<TextAnimation, number> = {
  none: 0,
  fadeIn: 300,
  popIn: 0,
  slideInUp: 350,
  slideInDown: 350,
  // 画面のキーフレームは 50%(=500ms の半分)で不透明になる
  bounce: 250,
  typewriter: 0
}

/**
 * 背景箱が文字からはみ出す量(**文字サイズに対する比**)。
 *
 * 画面は CSS の `padding`、書き出しは ASS の `\xbord`/`\ybord` と**書く場所が違うだけで
 * 同じ規則**なので、数字はここ1つに置く(上下左右の余白と同じ理由)。
 * 比で持つのが肝心——書き出し側は `\bord6` と**出力ピクセルの決め打ち**だったため、
 * 文字サイズを変えても箱の余白が変わらず、画面と食い違っていた。
 * 実測(1280 のキャンバス基準・左右): 文字サイズ 20/40/80 で画面は 8.0/16.0/32.0 なのに
 * 書き出しは **6/6/6** のまま。既定の 40 でも **2.67倍**の開きがあった。
 *
 * ASS の `\bord` は上下左右が同じ値になるが、`\xbord`/`\ybord` なら軸ごとに指定できる
 * (この libass で動くことを実測済み: `\xbord16\ybord6` で箱が 44x52 → 64x52px)。
 */
export const TEXT_BOX_PADDING_H_EM = 0.4
export const TEXT_BOX_PADDING_V_EM = 0.15

/**
 * 影の落とし幅(**テロップのキャンバス**のピクセル)と濃さ。
 *
 * 余白・箱の余白・飛び込む距離・登場の長さと同じく、画面(CSS の `text-shadow`)と
 * 書き出し(ASS の `\shad` / `\4a`)が**書く場所が違うだけで同じ規則**。
 * ところが**影だけが共通の置き場へ移されないまま**、両側に別の数字が書かれていた。
 * 落とし幅は偶然どちらも 2 で揃っていたが、**濃さは食い違っていた**。
 *
 * 実測(文字サイズ200・縁取り無し・白地に白文字＝影だけが見える状態):
 * - 書き出し: 焼いた画で一番暗い画素が **95**(白 255 に対して)。`\4a&H60&` の
 *   不透明度 0.624 から計算した 96 と一致する
 * - 画面: `getComputedStyle` の `text-shadow` が **`rgba(0, 0, 0, 0.7)`** で、
 *   同じ白地なら芯は **77** ——**画面のほうが濃い**(白からの落ち込みが 178 対 160)
 * さらに画面側だけ**落とし幅の2倍のぼかし**が掛かっていた。ASS の `\shad` は
 * ぼかさない**硬い影**なので、画面はふんわり・書き出しはくっきりと別物に見える。
 *
 * 濃さは**書き出し側の値に揃える**。成果物は書き出しのほうで、画面はそれを予告する係。
 * `0.6235` は `Math.round((1 - 0.6235) * 255) = 96` = `&H60&` と、
 * **今までの書き出しと1ビットも変わらない**値。
 */
export const TEXT_SHADOW_OFFSET_PX = 2
export const TEXT_SHADOW_OPACITY = 0.6235

/**
 * 文字サイズから背景箱の余白を出す。単位は**渡した文字サイズと同じ**
 * (書き出しなら ASS キャンバスのピクセル)。
 * 文字サイズが数値でない・0以下なら余白なし(負の `\xbord` を書き出さない)。
 */
export function textBoxPaddingPx(fontSize: number): { x: number; y: number } {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0
  return { x: size * TEXT_BOX_PADDING_H_EM, y: size * TEXT_BOX_PADDING_V_EM }
}

/**
 * 回転・拡大の**軸**(CSS の `transform-origin` に入れる値)。
 *
 * 書き出し(ASS)は `\frz`(回転)も `\fscx/\fscy`(登場アニメの拡大)も、
 * **`\an` で決まる配置のアンカー**を軸に掛ける。画面の CSS は既定で**箱の中心**を軸に
 * するので、同じ設定でも**画面と出力で別の場所に描かれる**。
 * 余白・箱の余白・飛び込む距離と同じく「書く場所が違うだけで同じ規則」なので、
 * 対応はここ1箇所に置く(`assSubtitle` の `alignmentFor` と対になる: 下=an2 / 上=an8 /
 * 中央・自由配置=an5)。
 *
 * 実測(1280x720・文字サイズ80・下ぞろえ):
 * - 回転: 書き出しは ink の中心が 0°→45° で **(+1.64%, +1.67%)** 動くのに、
 *   画面は **(0.00%, 0.00%)** と動かない(軸が違うため)。逆算した書き出しの軸は
 *   (634.5, 655.3) で、**行の下端中央**(ink 下端 654)と一致した
 * - 拡大: 登場アニメ `popIn` の途中(0.02秒)で、書き出しの ink は
 *   **下端 654→656 とほぼ動かず**上端だけ 594→619 へ下がる = 下端を軸に縮んでいる。
 *   画面は箱の中心を軸に縮むので、出だしの位置が食い違う
 *
 * 自由配置(`customPosition`)は書き出しが `\an5\pos` なので中心。
 * 知らない値は `alignmentFor` と同じく中央に倒す(手書きの `.veproj` 対策)。
 */
export function textAnchorOriginCss(
  position: TextPosition,
  hasCustomPosition: boolean = false
): string {
  if (hasCustomPosition) return '50% 50%'
  if (position === 'bottom') return '50% 100%'
  if (position === 'top') return '50% 0%'
  return '50% 50%'
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'sans-serif',
    fontSize: 40,
    color: '#ffffff',
    position: 'bottom',
    rotation: 0,
    bold: true,
    italic: false,
    outline: true,
    outlineColor: '#000000',
    outlineWidth: 3,
    shadow: false,
    background: false,
    backgroundColor: '#000000',
    backgroundOpacity: 0.5,
    letterSpacing: 0,
    animation: 'none',
    wordHighlight: false,
    highlightColor: '#ffe600',
    ...overrides
  }
}

export const FONT_FAMILY_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: 'sans-serif', label: 'ゴシック体' },
  { value: 'serif', label: '明朝体' },
  { value: 'M PLUS Rounded 1c', label: '丸ゴシック' },
  { value: 'Noto Sans JP', label: 'Noto Sans JP' },
  { value: 'Noto Serif JP', label: 'Noto Serif JP' }
]

const FONT_FAMILIES: readonly FontFamily[] = [
  'sans-serif',
  'serif',
  'M PLUS Rounded 1c',
  'Noto Sans JP',
  'Noto Serif JP'
]
const TEXT_POSITIONS: readonly TextPosition[] = ['top', 'center', 'bottom']
const TEXT_ANIMATIONS: readonly TextAnimation[] = [
  'none',
  'fadeIn',
  'popIn',
  'slideInUp',
  'slideInDown',
  'bounce',
  'typewriter'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function asNonNegative(value: unknown, fallback: number): number {
  return Math.max(0, asFinite(value, fallback))
}
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
function asOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * 外から来た「テロップの見た目」を、**必ず全項目が揃った形**に直す。
 *
 * `TextStyle` は書き出しで ASS のタグに焼かれる。`color` が無いだけで
 * `toAssColor(undefined)` が `undefined.replace(...)` を踏み、
 * **書き出しが生の英語で落ちる**(実測: 「Cannot read properties of undefined
 * (reading 'replace')」)。だから欠けは受け取った時点で埋める。
 *
 * **置き場がここなのは、外から来る道が1本ではないから。** プロジェクトファイル
 * (`projectStore` の読み込み)と、localStorage のお気に入り(`presetStore`)の
 * 両方が同じ規則を通る必要がある。片方だけが直す形にすると、直していない側の
 * 入口から入った値が同じ書き出しの式に届く。
 *
 * 知らない項目は落とさずに残す(将来増えた項目を読み込みで捨てないため)。
 */
export function normalizeTextStyle(raw: unknown): TextStyle {
  const base = defaultTextStyle()
  if (!isRecord(raw)) return base
  const custom = raw.customPosition
  return {
    ...base,
    // 知らない項目も残す(将来増えた項目を読み込みで落とさない)
    ...(raw as Partial<TextStyle>),
    fontFamily: asOneOf(raw.fontFamily, FONT_FAMILIES, base.fontFamily),
    fontSize: asFinite(raw.fontSize, base.fontSize),
    color: asNonEmptyString(raw.color, base.color),
    position: asOneOf(raw.position, TEXT_POSITIONS, base.position),
    customPosition:
      isRecord(custom) && typeof custom.x === 'number' && typeof custom.y === 'number'
        ? { x: asFinite(custom.x, 0.5), y: asFinite(custom.y, 0.5) }
        : undefined,
    rotation: asFinite(raw.rotation, base.rotation),
    bold: asBoolean(raw.bold, base.bold),
    italic: asBoolean(raw.italic, base.italic),
    outline: asBoolean(raw.outline, base.outline),
    outlineColor: asNonEmptyString(raw.outlineColor, base.outlineColor),
    outlineWidth: asNonNegative(raw.outlineWidth, base.outlineWidth),
    shadow: asBoolean(raw.shadow, base.shadow),
    background: asBoolean(raw.background, base.background),
    backgroundColor: asNonEmptyString(raw.backgroundColor, base.backgroundColor),
    backgroundOpacity: asFinite(raw.backgroundOpacity, base.backgroundOpacity),
    letterSpacing: asFinite(raw.letterSpacing, base.letterSpacing),
    animation: asOneOf(raw.animation, TEXT_ANIMATIONS, base.animation),
    wordHighlight: asBoolean(raw.wordHighlight, base.wordHighlight),
    highlightColor: asNonEmptyString(raw.highlightColor, base.highlightColor),
    extraStrokes: normalizeStrokes(raw.extraStrokes),
    gradientColor:
      typeof raw.gradientColor === 'string' && raw.gradientColor.length > 0
        ? raw.gradientColor
        : undefined
  }
}

/** 外側の縁の一覧。壊れた要素は捨て、幅は 0 以上の有限値にする。空なら undefined */
function normalizeStrokes(raw: unknown): TelopStroke[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TelopStroke[] = []
  for (const s of raw) {
    if (!isRecord(s)) continue
    const width = asNonNegative(s.width, 0)
    if (width <= 0) continue
    out.push({ color: asNonEmptyString(s.color, '#ffffff'), width })
  }
  return out.length > 0 ? out : undefined
}
