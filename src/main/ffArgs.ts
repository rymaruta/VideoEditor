/**
 * ffmpeg に渡す秒。`0.25 - 0.25` の丸めの残り(5.55e-17)のような値を JavaScript は指数で書き、
 * ffmpeg の `-ss`・`atrim` は読めずに書き出しごと失敗する。小数6桁で書く
 */
export function ffSeconds(sec: number): string {
  // 1e21 以上は toFixed でも指数になるので抑える(10 億秒 = 約 32 年)
  const v = Number.isFinite(sec) ? Math.min(1e9, Math.max(0, sec)) : 0
  return v < 5e-7 ? '0' : v.toFixed(6)
}
