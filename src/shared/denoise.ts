/** ピンマイクのノイズ除去の結果(1ファイルぶん) */
export interface DenoiseResult {
  source: string
  /** ノイズを除いた音声(作れなかったら undefined) */
  cleaned?: string
  error?: string
}
