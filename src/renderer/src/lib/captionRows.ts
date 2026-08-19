/**
 * テロップのレーンを**段に分ける**ための割り当て。
 *
 * テロップは1本のレーンに時刻だけで置いていたので、**時間が重なった2枚は寸分違わず
 * 同じ位置に重なり**、後から描かれた1枚しか掴めなかった。
 * (実測・1.0〜5.0秒の2枚: どちらも left 499 / top 641 / 幅 160 / 高さ 40 で完全に一致し、
 *  `document.elementFromPoint` は帯の左25%・中央・右75%の**3点とも上の1枚**を返した。
 *  下の1枚を拾える点は**0点**——選ぶことも動かすことも消すこともできない)
 *
 * そこで**重なったものだけ**段を足して縦にずらす。重なりが無ければ段は1つのままなので、
 * ふつうのプロジェクトの見た目は変わらない。
 *
 * 幅は**時刻そのもの**なので広げない(`.timeline-clip` の注記と同じ理由——
 * 掴みやすさのために広げると、広げたぶんがそのまま「時刻の嘘」になる)。
 * 短いテロップの掴み代は、幅ではなく**つまみの側を細くして**空ける。
 */

/**
 * どんなに短いテロップでも画面上はこの幅で描かれる(px)。
 * 幅は inline の `width` で指定しているが、`box-sizing: border-box` のもとでは
 * 左右の padding 6px と枠線 1px を下回れず、**実測でも 0.3秒(12px相当)と
 * 0.05秒(2px相当)がどちらも 14px** で描かれていた。
 * 段の重なりは「描かれた幅」で見ないと、短い1枚が隣の下に潜って掴めなくなる。
 */
export const CAPTION_MIN_DRAW_PX = 14

/** 段が2つ以上あるときの1段の高さ(px) */
export const CAPTION_ROW_HEIGHT = 22
/** 段が1つのときのレーンの高さ(px)。他のレーンと揃える */
export const CAPTION_LANE_MIN_HEIGHT = 44

export interface CaptionSpan {
  id: string
  startTime: number
  endTime: number
}

interface NormalizedSpan {
  id: string
  start: number
  end: number
  order: number
}

/**
 * 端が触れているだけ(前の終わり = 次の始まり)は重なりとみなさない。
 * 画面上も `left + width` がちょうど次の `left` になるだけで、重なって見えない。
 */
function normalize(overlay: CaptionSpan, order: number, minDurationSec: number): NormalizedSpan {
  const start = Number.isFinite(overlay.startTime) ? overlay.startTime : 0
  const rawEnd = Number.isFinite(overlay.endTime) ? overlay.endTime : start
  // 描かれる幅で見る。尺0や逆転した1枚も、画面では最低 CAPTION_MIN_DRAW_PX ぶん場所を取る
  return { id: overlay.id, start, end: Math.max(start + minDurationSec, rawEnd), order }
}

/**
 * それぞれのテロップを何段目に置くかを返す。
 * 始まりの早い順に見て、**空いている一番上の段**へ入れる。
 *
 * @param minDurationSec 画面上の最低幅を秒に直したもの(= CAPTION_MIN_DRAW_PX / 1秒あたりのpx)。
 *   省略すると時刻そのままで見る。
 */
export function assignCaptionRows(
  overlays: readonly CaptionSpan[],
  minDurationSec: number = 0
): Map<string, number> {
  const minSec = Number.isFinite(minDurationSec) && minDurationSec > 0 ? minDurationSec : 0
  const spans = overlays.map((o, i) => normalize(o, i, minSec))
  // 同じ時刻のものは元の並び順を保つ(描き順と段の順を揃えるため)
  spans.sort((a, b) => (a.start === b.start ? a.order - b.order : a.start - b.start))

  const rowEnds: number[] = []
  const rows = new Map<string, number>()
  for (const span of spans) {
    let row = rowEnds.findIndex((end) => end <= span.start)
    if (row < 0) {
      row = rowEnds.length
      rowEnds.push(span.end)
    } else {
      rowEnds[row] = span.end
    }
    rows.set(span.id, row)
  }
  return rows
}

/** 使った段の数。テロップが1枚も無くても 1 を返す(レーンの高さを出すため) */
export function captionRowCount(rows: ReadonlyMap<string, number>): number {
  let max = 0
  for (const row of rows.values()) max = Math.max(max, row + 1)
  return Math.max(1, max)
}

/** 段の数からレーンの高さを出す。1段なら今までと同じ 44px */
export function captionLaneHeight(rowCount: number): number {
  if (rowCount <= 1) return CAPTION_LANE_MIN_HEIGHT
  return rowCount * CAPTION_ROW_HEIGHT
}

/** 段の中でのテロップ1枚の位置。上下に 2px ずつ空ける */
export function captionRowRect(row: number, rowCount: number): { top: number; height: number } {
  const rowHeight = rowCount <= 1 ? CAPTION_LANE_MIN_HEIGHT : CAPTION_ROW_HEIGHT
  const safeRow = Number.isFinite(row) && row > 0 ? Math.floor(row) : 0
  return { top: safeRow * rowHeight + 2, height: Math.max(1, rowHeight - 4) }
}
