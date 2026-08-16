/** 原因が分からないときに残す手がかりの長さ。これ以上出しても読めない。 */
const MAX_DETAIL_LENGTH = 120

/**
 * ファイルが無いときの文言。**他の経路と1文字も変えない。**
 *
 * 同じ「ファイルが見つからない」に対して、取り込み(`describeFfmpegError`)も
 * プロジェクトの読み込み(`projectFileService`)もこの31文字を出す。ここだけ別の言い方に
 * すると、利用者から見て**同じ出来事が画面によって違う文になる**うえ、
 * 「全部の経路が通っているか」を文字数で数える掃引もすり抜ける。
 */
const MISSING_FILE_MESSAGE = 'ファイルが見つかりません。移動または削除された可能性があります'

/**
 * `shell.openPath` が返した文字列ごとの日本語。
 *
 * **判定を英文でやりたくはない**(文言は OS と Electron の版で変わる)。しかし
 * `shell.openPath` が返すのは**文字列だけ**で、`code` に相当するものが無いので、
 * ここだけは英文で当てるしかない。**当たらなくても下の既定文へ落ちる**ように組み、
 * 当たったぶんだけ具体的な次の一手を出す、という積み増しにしてある。
 */
const OPEN_PATH_MESSAGES: [RegExp, string][] = [
  [
    /no application|not associated|no app |couldn't find|cannot find an app|no registered/i,
    'このファイルを開けるアプリが見つかりませんでした。動画を再生できるアプリを設定してから、もう一度お試しください'
  ],
  [/permission|denied|EACCES|EPERM/i, 'このファイルを開く権限がありません'],
  [/no such file|not found|does not exist|ENOENT/i, MISSING_FILE_MESSAGE]
]

/**
 * 「再生」「フォルダを表示」の失敗を、利用者に見せられる短い日本語にする。
 *
 * `shell.openPath()` は失敗すると**OS が作った英語**をそのまま返す
 * (「No application is registered to handle this file type」など)。それを
 * `new Error()` に入れて投げていたので、**書き出しパネルにだけ英語が出ていた**。
 * 同じ `index.ts` の他の経路——保存の失敗・読み込みの失敗・素材の失敗——は
 * すべて日本語なので、ここだけが素通しだった。
 *
 * **「無い」かどうかは自分で判定する。** 戻り値の英文に頼ると版で当たらなくなるうえ、
 * `shell.showItemInFolder()` に至っては**戻り値が無く、失敗を知る手段が無い**
 * (押しても何も起きない)。呼ぶ前に実在を確かめれば、どちらの入口でも同じ答えになる。
 *
 * 見慣れない原因は**捨てずに**1行へ畳んで残す(唯一の手がかりになる)。
 * ただしそれは「日本語化した」とは数えないこと——既知の原因は上の表で
 * **英語を1文字も含まない**文にする。
 */
export function describeOpenPathFailure(exists: boolean, raw: string): Error {
  if (!exists) return new Error(MISSING_FILE_MESSAGE)
  const detail = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!detail) return new Error('ファイルを開けませんでした')
  for (const [pattern, message] of OPEN_PATH_MESSAGES) {
    if (pattern.test(detail)) return new Error(message)
  }
  const short =
    detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…` : detail
  return new Error(`ファイルを開けませんでした: ${short}`)
}

/** ファイルが無いときに投げるもの。「フォルダを表示」側もこれを使う。 */
export function missingFileError(): Error {
  return new Error(MISSING_FILE_MESSAGE)
}
