/**
 * クリップの速度を `<video>` / `<audio>` の `playbackRate` に入れられる値へ直す。
 *
 * Chromium は範囲外の値を**代入した時点で投げる**(実測 / Electron 39):
 *   `-1` と `16.1` と `0.0624` → `NotSupportedError`
 *   `NaN` / `±Infinity`        → `TypeError`
 *   受け付けたのは **0.0625 〜 16** ちょうど(0.0625 と 16 は通り、0.0624 と 16.1 は投げる)
 *
 * 代入しているのは `useEffect` の中なので、投げるとその場で React のエラー画面になる。
 * つまり**速度が壊れた `.veproj` を開いただけでアプリが使えなくなる**。
 * `speed` は保存ファイル由来で、`normalizeLoadedProject` は数値の範囲までは見ていない。
 *
 * 0 と NaN は `speed || 1` が 1 に倒すので実際には来ないが、
 * **入口が増えるたびに同じ穴が開く**ので、ここで全部まとめて受け止める。
 */
export const MIN_PLAYBACK_RATE = 0.0625
export const MAX_PLAYBACK_RATE = 16

export function toPlaybackRate(speed: number | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return 1
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, speed))
}
