/**
 * OBS の複数音声トラック・Craig の話者別ファイルの扱い(`docs/GAME_AUTO_EDIT_PLAN.md` G2)。
 *
 * OBS は1本の動画に音声を何本も入れられる(よくある設定: トラック1 = 全部入り、2 = マイク、
 * 3 = ゲーム音、4 = Discord)。アプリは1本目しか読まなかったので、トラックごとに音声ファイルへ
 * 取り出し(`main/obsTracks`)、それぞれを1つの音源として振り分ける。役割は名前と音の様子から推し量り、
 * 画面で直せる。
 */

/** 取り出したトラックの役割。voice = 話す人の声(文字起こし・話者・盛り上がりに使う) */
export type TrackRole = 'voice' | 'game' | 'mix'

export const TRACK_ROLE_LABEL: Record<TrackRole, string> = {
  voice: '声',
  game: 'ゲーム音',
  mix: '全部入り'
}

/** 動画から取り出した音声トラック(取り出したファイルの側に付ける) */
export interface ExtractedTrack {
  /** 元の動画のパス */
  parentPath: string
  /** 元の動画の、収録フォルダからの相対パス */
  parentRelativePath: string
  /** 音声トラックの番号(0 から。OBS の「トラック1」が 0) */
  index: number
  /** トラックの名前(OBS で付けた名前。無ければ undefined) */
  title?: string
  /** 推し量った役割 */
  role: TrackRole
}

const VOICE_TITLE = /mic|マイク|voice|声|discord|ディスコ|chat|vc|通話|commentary|実況/i
const GAME_TITLE = /game|ゲーム|desktop|デスクトップ|system|システム|app|bgm/i
const MIX_TITLE = /all|mix|全部|すべて|master|stream|配信/i

/**
 * 声の無い時間の割合。声だけのトラックは言葉と言葉の間が静か(実測の声のトラックで 3〜6 割)、
 * ゲーム音・全部入りはずっと何か鳴っている(1 割未満)。包絡線(10ms ごとの RMS)の上位 5% の大きさから
 * 20dB 以上小さい所を「静か」と数える
 */
export function quietRatio(envelope: Float32Array): number {
  const v = Array.from(envelope).filter((x) => Number.isFinite(x))
  if (v.length === 0) return 1
  const sorted = [...v].sort((a, b) => a - b)
  const loud = sorted[Math.floor(sorted.length * 0.95)]
  if (!(loud > 1e-5)) return 1
  const floor = loud * 0.1
  return v.filter((x) => x < floor).length / v.length
}

/** 声のトラックとみなす、静かな時間の割合の下限 */
export const VOICE_QUIET_RATIO = 0.3

/**
 * トラックの役割を推し量る。名前があれば名前で、無ければ1本目は全部入り(OBS の既定は全部をトラック1に録る)、
 * ほかは音の様子(静かな時間が多ければ声、ずっと鳴っていればゲーム音)で
 */
export function guessTrackRole(index: number, title: string | undefined, quiet: number): TrackRole {
  const t = title?.trim()
  if (t) {
    if (VOICE_TITLE.test(t)) return 'voice'
    if (GAME_TITLE.test(t)) return 'game'
    if (MIX_TITLE.test(t)) return 'mix'
  }
  if (index === 0) return 'mix'
  return quiet >= VOICE_QUIET_RATIO ? 'voice' : 'game'
}

/**
 * Craig(Discord の録音ボット)の話者別ファイルの名前から、話者の名前を取り出す。
 * 形は「1-taro.flac」「2-hanako_1234.flac」(番号-ユーザー名[_識別番号])。合わなければ null
 */
export function craigSpeakerName(fileName: string): string | null {
  const m = /^(\d{1,3})-(.+?)(?:_\d{1,4})?\.(flac|ogg|opus|wav|aac|m4a|mp3)$/i.exec(
    fileName.normalize('NFKC')
  )
  // 録音機の名前(`240501-120000.WAV`・`1-0001.wav`・`2024-05-01 12-00-00.wav`)と見分ける:
  // 話者の番号は小さく(3 桁まで)、名前には文字が入る(数字と区切りだけの名前は日時・連番)
  if (!m || !/\p{L}/u.test(m[2])) return null
  return m[2]
}

/** はっきり顔カメラと分かる名前(フォルダ・ファイル名のどこかに入る) */
const FACE_NAME_STRONG = /(^|[^a-z])face(cam)?\d*([^a-z]|$)|webcam|顔|ウェブカメ/i
/**
 * 顔カメラかもしれない名前。「cam」「camera」は単語として入るときだけ
 * (`campaign`・`Camp` のような言葉の一部は数えない)
 */
const FACE_NAME_WEAK = /(^|[^a-z])(cam|camera)\d*([^a-z]|$)|カメラ/i

export type CameraRole = 'screen' | 'face'

export const CAMERA_ROLE_LABEL: Record<CameraRole, string> = {
  screen: 'ゲーム画面',
  face: '顔カメラ'
}

/**
 * ゲーム実況のカメラの役割を推し量る。顔カメラは名前に cam・face・顔 などが入るか、
 * ゲーム画面より明らかに小さい(幅が一番大きいカメラの 3/4 未満)。
 * 音声トラックを何本も持つ録画(OBS)はゲーム画面
 */
export function guessCameraRole(
  relativePath: string,
  width: number | undefined,
  maxWidth: number,
  audioTracks: number
): CameraRole {
  const parts = relativePath.normalize('NFKC').split(/[/\\]/)
  // はっきりした名前を先に見る(顔カメラにも空間オーディオなどで音声を2本持つ機種がある)
  if (parts.some((p) => FACE_NAME_STRONG.test(p))) return 'face'
  if (audioTracks >= 2) return 'screen'
  if (parts.some((p) => FACE_NAME_WEAK.test(p))) return 'face'
  if (width && maxWidth && width < maxWidth * 0.75) return 'face'
  return 'screen'
}
