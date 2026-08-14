import type { TextOverlay, TranscriptWord } from './types'

/**
 * 単語ハイライト(カラオケ)に使える単語列を返す。使えないなら `null`。
 *
 * **テロップには文字が2つある。** 利用者が打ち込む `text` と、文字起こしが返した
 * `words`(1語ずつの時刻つき)。単語ハイライトONのときは**画面も書き出しも `words` だけ**を
 * 描いていたので、**`text` を打ち直しても何も変わらなかった**。入力欄には打った文字が
 * 出るのに、画面のテロップも書き出しも古い文字のまま——自動テロップの聞き間違いを
 * 直すのが編集の主目的なのに、それが黙って無視されていた。
 * (実測: 単語ハイライトONのテロップに「こんにちは世界です」と打ち直すと、
 *  ストアの `text` は変わるのに**画面は「こんにちはせかいです」のまま**で、
 *  書き出した mp4 は打つ前と **md5 まで完全に同一**だった。
 *  ハイライトOFFの同じ操作は画面も出力も追従していた——**片方にだけ育っていた**)
 *
 * 直し方は「打ち直したら `words` を捨てる」ではなく、**綴りが合っているときだけ使う**。
 * 捨てると打ち直しのたびに時刻が失われ、取り消しても戻らない。使う側で判断すれば、
 * **取り消して元の文字に戻せば色付きもそのまま戻る**。
 *
 * 判定は**空白まで含めて厳密に**見る(端の空白だけは作成時に `trim()` されるので落とす)。
 * 改行を1つ入れただけでも単語列は使わない——`words` から描くと**その改行が出ない**ので、
 * 「打ったのに反映されない」が小さく残ってしまう。色付きが消えるのは画面で見えるが、
 * 打った文字が出ないのは見えない。**見えない方を残さない。**
 *
 * 作成時は3経路とも `words` をそのまま連結したものが `text` になっている
 * (`whisperService.buildWordSegment` / 自動テロップ / AIショートの発言テロップ)ので、
 * 打ち直していない限りこの判定は必ず通る。
 */
export function karaokeWords(
  overlay: Pick<TextOverlay, 'text' | 'style' | 'words'>
): TranscriptWord[] | null {
  const words = overlay.words
  if (!overlay.style?.wordHighlight || !words || words.length === 0) return null
  const spelled = words.map((w) => w.text).join('')
  return spelled.trim() === (overlay.text ?? '').trim() ? words : null
}
