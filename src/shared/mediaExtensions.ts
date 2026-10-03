/**
 * 取り込みを受け付けるファイルの拡張子。
 *
 * ファイル選択ダイアログ(main)とドラッグ&ドロップ(renderer)の両方で使う。片方だけに
 * 書くと、**ダイアログでは選べるのにドロップだと無視される**ような食い違いが黙って生まれる。
 */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] as const
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] as const
export const MEDIA_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]
/**
 * 静止画(版面CG など)。**ワイプ・全面(CG)のトラックにだけ置ける**素材として読み込む
 * (本編や収録フォルダの読み取りには入れない)
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

export function isImagePath(filePath: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(filePath))
}

/** 静止画を素材にしたときの長さ(秒)。置いたクリップはこの範囲で好きな長さにできる */
export const STILL_DURATION_SEC = 3600

/** パスの拡張子を小文字で返す。拡張子が無ければ空文字(フォルダを落とすのに使う) */
export function fileExtension(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? filePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isSupportedMediaPath(filePath: string): boolean {
  return MEDIA_EXTENSIONS.includes(fileExtension(filePath))
}
