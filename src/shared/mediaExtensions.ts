/**
 * 取り込みを受け付けるファイルの拡張子。
 *
 * ファイル選択ダイアログ(main)とドラッグ&ドロップ(renderer)の両方で使う。片方だけに
 * 書くと、**ダイアログでは選べるのにドロップだと無視される**ような食い違いが黙って生まれる。
 */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] as const
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] as const
export const MEDIA_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]

/** パスの拡張子を小文字で返す。拡張子が無ければ空文字(フォルダを落とすのに使う) */
export function fileExtension(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? filePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isSupportedMediaPath(filePath: string): boolean {
  return MEDIA_EXTENSIONS.includes(fileExtension(filePath))
}
