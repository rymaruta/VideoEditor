import { rmSync } from 'fs'

/**
 * 試験の作業フォルダの後片付け。Windows ではウイルス対策・検索のインデックスが、作ったばかりの
 * ファイルを一瞬つかむことがあり、1回きりの rmSync が EBUSY・EPERM で落ちる(試験そのものは合格して
 * いるのに全体が終了コード 1 になる)。少し待って何回か試す。
 *
 * アプリ側の子プロセスが素材を開いたまま残る不具合は、これで隠さない: その確かめは
 * `tests/e2e/failedProbeReleasesFile.test.ts` が失敗の直後に(待たずに)行う
 */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
