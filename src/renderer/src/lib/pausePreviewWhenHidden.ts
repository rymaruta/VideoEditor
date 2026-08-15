import { useEffect, type RefObject } from 'react'

/**
 * 試聴用の `<audio>` を、そのパネルが画面から消えたら止める。
 *
 * **タブは付け替えではなく `display: none` の出し分け**なので(理由は App.tsx のコメント:
 * 走っている API 呼び出しを切り替えで捨てないため)、別のタブへ移ってもパネルは
 * **居たまま**で、`useEffect` の後片付けは走らない。**「画面から消えたら止まる」を
 * アンマウントに頼れない**のはこの1点で、`<audio>` は見えなくても鳴り続ける。
 *
 * 見えなくなったことを自分で気付く必要があるので、枠を見張って表示されなくなったら
 * 止める(`display: none` の要素は交差しない)。上位から「今どのタブか」を渡す形に
 * しなかったのは、この用途のために親の受け渡しを増やさないため。
 *
 * **規則をここ1箇所に置くのは、実際に片方だけ育ったから。** 同じ「隠れた `<audio>` で
 * 試聴する」パネルは2つ(効果音プリセットと BGM/効果音ライブラリ)あり、
 * 見張りが付いていたのはプリセットだけだった。
 * (実測: 同じ操作——試聴を鳴らしてから「書き出し」タブへ移り、1.2秒待つ——で
 *  プリセットは **paused=true / 再生位置 0.63→0.68秒で停止**、ライブラリは
 *  **paused=false / 再生位置 0.65→2.25秒と進み続けた**。ライブラリ側には
 *  停止ボタンもトグルも無いので、鳴らしたら**最後まで止められない**)
 */
export function pausePreviewWhenHidden(
  panel: HTMLElement | null,
  audio: HTMLAudioElement | null,
  onStop?: () => void
): () => void {
  const stop = (): void => {
    audio?.pause()
    onStop?.()
  }
  if (!panel || typeof IntersectionObserver === 'undefined') {
    // 見張れない環境でも、後片付けでは必ず止める(鳴りっぱなしを残さない)。
    return stop
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => !e.isIntersecting)) stop()
  })
  observer.observe(panel)
  return () => {
    observer.disconnect()
    stop()
  }
}

/**
 * `pausePreviewWhenHidden` を effect として掛ける。
 *
 * 後片付けで `ref.current` を読むと、そのときには別の要素を指しているかもしれない。
 * 試聴用の `<audio>` とパネルの枠はどちらも**常に描いている**ので、掛けるときに
 * 捕まえた1枚を使い続けてよい。
 */
export function usePausePreviewWhenHidden(
  panelRef: RefObject<HTMLElement | null>,
  audioRef: RefObject<HTMLAudioElement | null>,
  onStop?: () => void
): void {
  useEffect(() => {
    return pausePreviewWhenHidden(panelRef.current, audioRef.current, onStop)
    // 掛け直さない: 見張る相手は描き始めから消えるまで同じ1枚。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
