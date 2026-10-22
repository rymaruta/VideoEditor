/**
 * Alt を**単独で**押して離したか(Windows のメニューバーと同じ操作)を見分ける。
 * Windows / Linux では OS のメニューバーを出さないので、Alt の単独押しで上の帯の「メニュー」
 * ボタンへフォーカスを移す(Enter・Space・↓ で開く)。
 *
 * Alt を押している間にほかのキー(Alt+ドラッグ・Alt+キーの操作)・マウスのボタンが入ったら、
 * 単独押しではない。キーの繰り返し(押しっぱなし)は単独押しのまま。
 */
export interface AltTapDetector {
  keydown: (e: { key: string; repeat?: boolean }) => void
  /** 離したキーが単独押しの Alt なら true */
  keyup: (e: { key: string }) => boolean
  /** マウスのボタンを押した・窓のフォーカスが外れた */
  cancel: () => void
}

export function createAltTapDetector(): AltTapDetector {
  let armed = false
  return {
    keydown: (e) => {
      if (e.key === 'Alt') {
        if (!e.repeat) armed = true
        return
      }
      armed = false
    },
    keyup: (e) => {
      const hit = armed && e.key === 'Alt'
      armed = false
      return hit
    },
    cancel: () => {
      armed = false
    }
  }
}
