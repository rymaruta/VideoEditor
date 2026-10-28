/**
 * 画面の言い回しの一覧(1 か所)。新しく字を書くときはここの言い方に合わせる。
 * `TERM_RULES` は tests/lib/designRules.test.ts が画面の文字列(コメント以外)を調べるのに使う。
 *
 * - テロップ: 画面に重ねる文字。「字幕」は SRT(字幕ファイル)の読み書きの文脈だけ
 * - 書き出す: ボタンの動詞。メニューと窓の名前は「書き出し…」。書き出す先は「保存先」
 * - 仮編集: 自動で組んだ最初の並び(「ラフカット」とは言わない)
 * - 縦横比(「アスペクト比」とは言わない)
 * - API キー(英字とカナの間に半角の空き)
 * - インスペクタ / サムネイル(タブの名前も略さない)
 * - 素材: 読み込んだ動画・音声・画像(「メディア」とは言わない。OS のファイルの種類の名前は別)
 * - キャンセル と 閉じる: 何かを決める窓(主ボタンがある)は「キャンセル」、見るだけ・その場で
 *   当てる窓は「閉じる」。「OK」は使わず、結果の動詞(保存する・適用 など)にする
 * - 処理中の「…」は全角の三点リーダ 1 字(「...」は使わない)
 * - シーケンスは Premiere に渡す物とメニューの名前だけ(ほかはタイムライン)
 * - トラックの固定: 言葉は「固定」、アイコンはピン(固定したトラックのクリップは変えられない)。
 *   「ロック」は範囲の自動編集で「作り直さない」印のことだけに使い、アイコンは鍵。
 *   トラックには「ロック」も鍵も使わない
 */
export const TERMS = {
  telop: 'テロップ',
  exportVerb: '書き出す',
  exportMenu: '書き出し…',
  exportTarget: '保存先',
  roughCut: '仮編集',
  aspect: '縦横比',
  apiKey: 'API キー',
  inspector: 'インスペクタ',
  thumbnail: 'サムネイル',
  asset: '素材',
  cancel: 'キャンセル',
  close: '閉じる',
  ellipsis: '…',
  trackLock: 'トラックの固定'
} as const

/** 使わない言い方(見つけたら `use` に直す)。`allow` に当たる行は除く */
export const TERM_RULES: readonly { avoid: RegExp; use: string; allow?: RegExp }[] = [
  { avoid: /APIキー/, use: TERMS.apiKey },
  { avoid: /アスペクト比/, use: TERMS.aspect },
  { avoid: /ラフカット/, use: TERMS.roughCut },
  { avoid: /インスペクター/, use: TERMS.inspector },
  { avoid: /'サムネ'/, use: TERMS.thumbnail },
  { avoid: /メディア(?!ファイル)/, use: TERMS.asset },
  {
    avoid: /字幕/,
    use: TERMS.telop,
    allow: /SRT|字幕ファイル|字幕を(書き出し|読み込み)|本の字幕|字幕が見つかり/
  },
  { avoid: /[\u3040-\u30ff\u3400-\u9fff)）]\.\.\./, use: TERMS.ellipsis },
  { avoid: /出力先/, use: TERMS.exportTarget },
  { avoid: /トラック(の|を)ロック|ロックした(トラック|本編|テロップ)/, use: TERMS.trackLock },
  { avoid: />\s*OK\s*<|'OK'/, use: '結果の動詞(保存する・適用 など)' }
]
