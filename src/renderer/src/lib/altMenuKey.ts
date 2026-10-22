/**
 * Alt を**単独で**押して離したか(Windows のメニューバーと同じ操作)を見分ける。
 * Windows / Linux では OS のメニューバーを出さないので、Alt の単独押しで上の帯の「メニュー」
 * ボタンへフォーカスを移す(Enter・Space・↓ で開く)。
 *
 * Alt を押している間にほかのキー(Alt+ドラッグ・Alt+キーの操作)・マウスのボタンが入ったら、
 * 単独押しではない。キーの繰り返し(押しっぱなし)は単独押しのまま。
 */
export interface AltTapDetector {
  keydown: (e: { key: string; repeat?: boolean; isComposing?: boolean; keyCode?: number }) => void
  /** 離したキーが単独押しの Alt なら true */
  keyup: (e: { key: string; isComposing?: boolean; keyCode?: number }) => boolean
  /** マウスのボタンを押した・窓のフォーカスが外れた */
  cancel: () => void
}

/** 日本語入力(IME)の変換中のキーか(isComposing、または変換中に来る keyCode 229) */
export function isComposingKey(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229
}

export function createAltTapDetector(): AltTapDetector {
  let armed = false
  return {
    keydown: (e) => {
      // 日本語入力の変換中は何もしない(変換の Alt・文字を奪わない)
      if (isComposingKey(e)) {
        armed = false
        return
      }
      if (e.key === 'Alt') {
        if (!e.repeat) armed = true
        return
      }
      armed = false
    },
    keyup: (e) => {
      if (isComposingKey(e)) {
        armed = false
        return false
      }
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
  isComposing?: boolean
  keyCode?: number
}

/**
 * Alt+英字が上の段のメニューのニーモニック(Alt+F でファイル など)なら、その英字(大文字)。
 * Ctrl・Shift・Cmd と一緒のとき・ニーモニックに無い英字(キー操作の Alt+X など)は null。
 * キーの位置(code)で見る(macOS の Option+英字は別の文字になるため。日本語入力中も同じ位置)
 */
export function menuMnemonicFor(e: MnemonicKey, mnemonics: readonly string[]): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isComposingKey(e)) return null
  const fromCode = /^Key([A-Z])$/.exec(e.code ?? '')?.[1]
  const letter = fromCode ?? (e.key.length === 1 ? e.key.toUpperCase() : '')
  return letter && mnemonics.includes(letter) ? letter : null
}
