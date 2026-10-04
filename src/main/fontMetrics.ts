import { execFile } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { retryableSingleton } from './retryableSingleton'
import { fontMetricsKey } from './assSubtitle'
import type { TextOverlay } from '@shared/types'

/**
 * **libass が実際に使う「1文字あたりの送り幅」を、libass 自身に描かせて測る。**
 *
 * 折り返しの見積もりは今まで「全角=1em」の決め打ちだった。main プロセスには
 * フォントの字送りを測る手段が無い、というのが理由だが、**libass は手元にある**
 * (書き出しに使っている ffmpeg の `subtitles` フィルタがそれ)。1度だけ描かせて
 * 測れば、決め打ちを増やさずに実際の値が手に入る。
 *
 * 決め打ちの数字を新しく置かないのが肝心。実測(この環境)では全角の送り幅は
 * **0.812em** だったが、これは**その環境で選ばれたフォントの性質**でしかない
 * (CJK フォントが入っていない環境なので WenQuanYi Zen Hei に落ちていた。
 * 日本語フォントが入っていれば 1.0em になるのが普通)。
 * **0.81 を定数として焼き込むと、字送りが 1.0em の環境で見積もりが 19% 足りなくなり、
 * 空白の無い日本語は libass 自身では折り返せないので、そのままフレームの外へ出て
 * 両端が切れる。** だから「測る」以外に正しいやり方が無い。
 *
 * 測り方: 同じ文字を N 個と 2N 個描いてインク幅の差を取る。差 ÷ N が送り幅ちょうど
 * (両端のサイドベアリングが引き算で消える)。
 */

/** 測り値がこの範囲から外れたら信用しない(描画に失敗して黒画面、などを弾く) */
const PLAUSIBLE_MIN_EM = 0.5
const PLAUSIBLE_MAX_EM = 1.5

/** 見積もりに戻すときの値。今までと同じ「実フォントより広め」の側 */
export const FALLBACK_WIDE_EM = 1

const PROBE_CHAR = 'あ'
const PROBE_FONT_SIZE = 40
const PROBE_N = 6
const PROBE_W = 960
const PROBE_H = 120
/** インクがこの位置より右に届いたら、枠で切られている可能性があるので捨てる */
const CLIP_GUARD_X = PROBE_W - 8

function probeAss(text: string, fontFamily: string, bold: boolean): string {
  // WrapStyle: 2 = 折り返さない。測っている最中に折り返されると幅が意味を失う。
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${PROBE_W}
PlayResY: ${PROBE_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: P,${fontFamily},${PROBE_FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,${bold ? 1 : 0},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,P,,0,0,0,,{\\pos(2,2)\\an7\\bord0\\shad0}${text}
`
}

/** フィルターに渡すファイルの名前(理由は ffmpegService の escapeFilterPath。同じ書き方) */
function escapeFilterPath(p: string): string {
  const inner = p.replace(/\\/g, '/').replace(/[\\':]/g, '\\$&')
  return inner.replace(/[\\'[\],;]/g, '\\$&')
}

/** その文字列を libass に描かせて、インクの左端・右端を返す(何も描かれなければ null) */
async function inkExtent(
  ffmpegPath: string,
  assPath: string
): Promise<{ lo: number; hi: number } | null> {
  const gray = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=black:s=${PROBE_W}x${PROBE_H}:d=0.1`,
        '-vf',
        `subtitles=filename=${escapeFilterPath(assPath)}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-'
      ],
      { encoding: 'buffer', maxBuffer: PROBE_W * PROBE_H * 4 + 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer))
    )
  })
  if (gray.length < PROBE_W * PROBE_H) return null
  let lo = PROBE_W
  let hi = -1
  for (let y = 0; y < PROBE_H; y++) {
    for (let x = 0; x < PROBE_W; x++) {
      if (gray[y * PROBE_W + x] > 60) {
        if (x < lo) lo = x
        if (x > hi) hi = x
      }
    }
  }
  return hi < 0 ? null : { lo, hi }
}

async function measure(ffmpegPath: string, fontFamily: string, bold: boolean): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 've-fontprobe-'))
  try {
    const widths: number[] = []
    for (const n of [PROBE_N, PROBE_N * 2]) {
      const assPath = join(dir, `probe${n}.ass`)
      writeFileSync(assPath, probeAss(PROBE_CHAR.repeat(n), fontFamily, bold), 'utf-8')
      const ink = await inkExtent(ffmpegPath, assPath)
      if (!ink) throw new Error('何も描かれなかった')
      // 枠に触れているなら切られている。切られた幅で割り算をすると静かに間違える
      if (ink.hi >= CLIP_GUARD_X) throw new Error('probe が枠に収まらなかった')
      widths.push(ink.hi - ink.lo + 1)
    }
    const advanceEm = (widths[1] - widths[0]) / PROBE_N / PROBE_FONT_SIZE
    if (
      !Number.isFinite(advanceEm) ||
      advanceEm < PLAUSIBLE_MIN_EM ||
      advanceEm > PLAUSIBLE_MAX_EM
    ) {
      throw new Error(`測り値が範囲外: ${advanceEm}`)
    }
    return advanceEm
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * フォントごとの測定を1回だけ走らせて使い回す。
 * **失敗は覚えない**(`retryableSingleton` の理由と同じ。1回コケただけで、
 * 以後ずっと見積もりに落ちたままになるのを避ける)。
 */
const cache = new Map<string, () => Promise<number>>()

/**
 * 全角1文字の送り幅(フォントサイズに対する比)を返す。
 * 測れなかったときは `null`。**呼び出し側は今までどおりの見積もりに倒すこと**——
 * ここで例外を投げて書き出しごと止めてはいけない(折り返しが少し広いだけの話で、
 * 書き出せなくなるほうがはるかに悪い)。
 */
export async function wideAdvanceEm(
  ffmpegPath: string,
  fontFamily: string,
  bold: boolean
): Promise<number | null> {
  // **ffmpeg の場所もキーに入れる。** 入れないと、最初の呼び出しで渡された場所を
  // 掴んだままの関数が残り、あとから正しい場所を渡しても**古い場所で測り直す**。
  // `retryableSingleton` は失敗した Promise は捨てるが、捨てるのは結果だけで、
  // 「何をやり直すか」は最初に作った関数のままなので、ここで分けておく必要がある。
  // 区切りの NUL は **`\x00` というエスケープ表記で書くこと**。生のバイトを置くと
  // 意味は同じままファイルが**バイナリ扱い**になり、`git diff` が `Binary files differ`
  // しか出さず、`grep -rn` が行を落とし、3方向マージができなくなる(理由と実測は
  // `src/shared/fileName.ts` の同じ注記)。
  const key = `${ffmpegPath}\x00${fontMetricsKey(fontFamily, bold)}`
  let get = cache.get(key)
  if (!get) {
    get = retryableSingleton(() => measure(ffmpegPath, fontFamily, bold))
    cache.set(key, get)
  }
  try {
    return await get()
  } catch {
    return null
  }
}

/**
 * テロップが使っているフォントを全部測って、`buildAssContent` に渡せる表にする。
 *
 * 測れなかったフォントは**表に入れない**。入れないほうが、引く側が既定の見積もりに
 * 倒れて今までどおり動く(0 や NaN を入れると、そのフォントだけ折り返しが壊れる)。
 * 1つのフォントで代表させないのが肝心——別のフォントの送り幅を当てはめると、
 * 狭いほうへ外したときに枠からはみ出す。
 */
export async function measureWideAdvances(
  ffmpegPath: string,
  overlays: readonly TextOverlay[]
): Promise<Map<string, number>> {
  const wanted = new Map<string, { fontFamily: string; bold: boolean }>()
  for (const o of overlays) {
    const style = o.style
    if (!style) continue
    wanted.set(fontMetricsKey(style.fontFamily, style.bold), {
      fontFamily: style.fontFamily,
      bold: style.bold
    })
  }
  const out = new Map<string, number>()
  await Promise.all(
    [...wanted].map(async ([key, { fontFamily, bold }]) => {
      const em = await wideAdvanceEm(ffmpegPath, fontFamily, bold)
      if (em !== null) out.set(key, em)
    })
  )
  return out
}

/** テスト用。測り直させたいときに使う */
export function clearFontMetricsCache(): void {
  cache.clear()
}
