import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { createHash } from 'crypto'

/** 頭と終わりから読む長さ(バイト) */
const SAMPLE_BYTES = 64 * 1024

/**
 * ファイルの中身の目印(頭と終わりの 64KB と大きさのハッシュ)。解析結果のキャッシュの鍵に足す。
 *
 * 鍵がパス・大きさ・更新時刻だけだと、同じ名前・同じ長さ(PCM の録音は同じ長さなら同じ大きさ)・
 * 同じ更新時刻のファイルに差し替えたとき(時計の合っていない録音機が ZOOM0001.WAV を使い回す、
 * 更新時刻を保つコピー、2秒刻みの exFAT)、前のファイルの結果をそのまま返していた。
 * 読めなければ空文字(鍵は大きさ・更新時刻だけになる)
 */
export function contentFingerprint(path: string): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const hash = createHash('sha1').update(String(size))
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size))
    readSync(fd, head, 0, head.length, 0)
    hash.update(head)
    if (size > SAMPLE_BYTES) {
      const tail = Buffer.alloc(Math.min(SAMPLE_BYTES, size - SAMPLE_BYTES))
      readSync(fd, tail, 0, tail.length, size - tail.length)
      hash.update(tail)
    }
    return hash.digest('hex').slice(0, 16)
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
