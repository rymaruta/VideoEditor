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

/** キーの出来事のうち、見る所だけ */
export interface MnemonicKey {
  key: string
  code?: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * Alt+英字が上の段のメニューのニーモニック(Alt+F でファイル など)なら、その英字(大文字)。
 * Ctrl・Shift・Cmd と一緒のとき・ニーモニックに無い英字(キー操作の Alt+X など)は null。
 * キーの位置(code)で見る(macOS の Option+英字は別の文字になるため。日本語入力中も同じ位置)
 */
export function menuMnemonicFor(e: MnemonicKey, mnemonics: readonly string[]): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  const fromCode = /^Key([A-Z])$/.exec(e.code ?? '')?.[1]
  const letter = fromCode ?? (e.key.length === 1 ? e.key.toUpperCase() : '')
  return letter && mnemonics.includes(letter) ? letter : null
}
