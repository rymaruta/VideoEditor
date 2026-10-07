/**
 * ゲーム画面の動かない表示(HUD: 体力・スコア・ミニマップ・ボタンの案内)を見つけ、
 * 発言テロップをそこに重ねない(`docs/GAME_AUTO_EDIT_PLAN.md` G3)。
 *
 * 録画のあちこちから小さな画を取り、画素ごとに「輪郭がはっきりしている(文字・枠)」のに
 * 「時間が経っても変わらない」所を HUD とみなす。ゲームの絵は動くので変わり、HUD は同じ所に居続ける。
 * 画面を格子に分けて、HUD の画素の多いマスを HUD のマスにする。
 */

export interface HudMap {
  cols: number
  rows: number
  /** マスごとの HUD らしさ(0〜1。HUD の画素の割合) */
  cells: Float32Array
}

export interface HudOptions {
  cols?: number
  rows?: number
  /** 輪郭の強さ(隣の画素との明るさの差、0〜255)の下限 */
  edge?: number
  /** 時間による明るさの揺れ(標準偏差、0〜255)の上限 */
  steady?: number
}

/** 画素の明るさ(0〜255)。RGB の並び */
function luma(rgb: Uint8Array, i: number): number {
  return 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]
}

/**
 * 同じ大きさ(w×h)の RGB の画の並びから、HUD のマスを求める。画が 3 枚未満なら null
 * (動いているかどうかを見分けられない)
 */
export function detectHud(
  frames: readonly Uint8Array[],
  w: number,
  h: number,
  options: HudOptions = {}
): HudMap | null {
  const ok = frames.filter((f) => f.length === w * h * 3)
  if (ok.length < 3) return null
  const cols = options.cols ?? 16
  const rows = options.rows ?? 9
  const edgeMin = options.edge ?? 40
  const steadyMax = options.steady ?? 12
  const n = w * h
  const sum = new Float32Array(n)
  const sq = new Float32Array(n)
  const edge = new Float32Array(n)
  for (const f of ok) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const v = luma(f, i)
        sum[i] += v
        sq[i] += v * v
        const right = x + 1 < w ? luma(f, i + 1) : v
        const down = y + 1 < h ? luma(f, i + w) : v
        edge[i] += Math.max(Math.abs(v - right), Math.abs(v - down))
      }
    }
  }
  const k = ok.length
  const hits = new Float32Array(cols * rows)
  const counts = new Float32Array(cols * rows)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const mean = sum[i] / k
      const sd = Math.sqrt(Math.max(0, sq[i] / k - mean * mean))
      const cell =
        Math.min(rows - 1, Math.floor((y / h) * rows)) * cols +
        Math.min(cols - 1, Math.floor((x / w) * cols))
      counts[cell]++
      if (edge[i] / k >= edgeMin && sd <= steadyMax) hits[cell]++
    }
  }
  const cells = new Float32Array(cols * rows)
  for (let c = 0; c < cells.length; c++) cells[c] = counts[c] ? hits[c] / counts[c] : 0
  return { cols, rows, cells }
}

/** 画面の比の矩形(0〜1)に掛かる HUD の割合(マスの HUD らしさの、面積で重みを付けた平均) */
export function hudCoverage(
  map: HudMap,
  rect: { x0: number; y0: number; x1: number; y1: number }
): number {
  let total = 0
  let area = 0
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const cx0 = c / map.cols
      const cy0 = r / map.rows
      const ox = Math.max(0, Math.min(rect.x1, cx0 + 1 / map.cols) - Math.max(rect.x0, cx0))
      const oy = Math.max(0, Math.min(rect.y1, cy0 + 1 / map.rows) - Math.max(rect.y0, cy0))
      const a = ox * oy
      if (a <= 0) continue
      total += a * map.cells[r * map.cols + c]
      area += a
    }
  }
  return area > 0 ? total / area : 0
}

/** 発言テロップ(下の中央)が占める帯。2行・1行 14 字の大きさで、横は真ん中の 6 割 */
export const SPEECH_BAND = { x0: 0.2, x1: 0.8, height: 0.16 }

/** これを超えて HUD に掛かるなら、発言テロップを動かす */
export const HUD_OVERLAP_LIMIT = 0.08

/**
 * 発言テロップの帯の中心の高さ(画面の比)を、HUD に掛からない所へ決める。
 * 既定の位置(`defaultY`)で掛からなければ null(動かさない)。下から上へ探し、
 * 画面の中ほど(0.55)まで上げても掛かるなら、一番掛からない高さにする
 */
export function speechYAvoidingHud(map: HudMap, defaultY: number): number | null {
  const at = (y: number): number =>
    hudCoverage(map, {
      x0: SPEECH_BAND.x0,
      x1: SPEECH_BAND.x1,
      y0: y - SPEECH_BAND.height / 2,
      y1: y + SPEECH_BAND.height / 2
    })
  if (at(defaultY) <= HUD_OVERLAP_LIMIT) return null
  let best = defaultY
  let bestCover = at(defaultY)
  for (let y = defaultY - 0.01; y >= 0.55; y -= 0.01) {
    const c = at(y)
    if (c <= HUD_OVERLAP_LIMIT) return Math.round(y * 1000) / 1000
    if (c < bestCover) {
      best = y
      bestCover = c
    }
  }
  return Math.round(best * 1000) / 1000
}

/**
 * 素材の絵の中の HUD のマスを、画面(テロップのキャンバス)のマスへ写す。`fit` は絵が画面に収まる所
 * (`containRect`)。絵の外(黒い帯)は HUD 無し
 */
export function hudMapToCanvas(
  map: HudMap,
  fit: { x: number; y: number; w: number; h: number }
): HudMap {
  if (Math.abs(fit.w - 1) < 1e-6 && Math.abs(fit.h - 1) < 1e-6) return map
  const cells = new Float32Array(map.cols * map.rows)
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      // 画面のマスを、絵の中の比へ戻す(絵の外は切り捨てる)
      const x0 = (c / map.cols - fit.x) / fit.w
      const x1 = ((c + 1) / map.cols - fit.x) / fit.w
      const y0 = (r / map.rows - fit.y) / fit.h
      const y1 = ((r + 1) / map.rows - fit.y) / fit.h
      const rect = {
        x0: Math.max(0, x0),
        x1: Math.min(1, x1),
        y0: Math.max(0, y0),
        y1: Math.min(1, y1)
      }
      if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) continue
      // 絵に掛かる面積の割合で薄める(マスの一部だけが絵なら、HUD もその分だけ)
      const inside = ((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / ((x1 - x0) * (y1 - y0))
      cells[r * map.cols + c] = hudCoverage(map, rect) * inside
    }
  }
  return { cols: map.cols, rows: map.rows, cells }
}
