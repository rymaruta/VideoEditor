import type { TelopLayerStageApi } from '@shared/telop/layer'

/**
 * 書き出しのテロップの層の画像を、**同じ中身は1枚にまとめ、数 MB ずつ** main へ送る。
 *
 * - 中身(バイト列)が同じ画像には同じ番号を返し、送らない。絵の鍵(`planTelopRuns`)が違っても
 *   描いた結果が同じになることがある(点滅の消えている間・何も描かれない瞬間など)
 * - 送るのは `batchBytes` 溜まるごと。送っている束は1つだけで、次の束はその間に溜める。
 *   main は書き終えてから返すので、ディスクが遅くても画面のプロセスに溜まるのは束2つぶんまで
 */
export class TelopImageWriter {
  /** 番号を振った枚数(0番の透明を含む) */
  count = 0
  private readonly byDigest = new Map<string, number>()
  private batch: Uint8Array[] = []
  private batchFirst = 0
  private batchSize = 0
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly stage: Pick<TelopLayerStageApi, 'append'>,
    private readonly id: string,
    /**
     * 1回に送る量。IPC は1回ごとに送る側・受ける側で丸ごと複製するので、大きすぎると山が高くなり、
     * 小さすぎると往復の回数が増える(1080p の PNG は 1枚 約 65KB、4K は約 210KB)
     */
    private readonly batchBytes = 16 * 1024 * 1024
  ) {}

  /** 画像を加えて、その番号を返す(同じ中身がすでにあればその番号) */
  async add(bytes: Uint8Array): Promise<number> {
    const key = await digestKey(bytes)
    const known = this.byDigest.get(key)
    if (known !== undefined) return known
    const index = this.count++
    this.byDigest.set(key, index)
    if (this.batch.length === 0) this.batchFirst = index
    this.batch.push(bytes)
    this.batchSize += bytes.byteLength
    if (this.batchSize >= this.batchBytes) await this.flush()
    return index
  }

  /** 溜めている束を送り出す(前の束が書き終わるのを待ってから) */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight
    this.inFlight = null
    if (this.batch.length === 0) return
    const images = this.batch
    const first = this.batchFirst
    this.batch = []
    this.batchSize = 0
    const sending = this.stage.append(this.id, first, images)
    // 待つのは次の `flush`/`finish`。それまでに失敗しても、未処理の拒否にしない
    sending.catch(() => {})
    this.inFlight = sending
  }

  /** 全部を送り終えるまで待つ */
  async finish(): Promise<void> {
    await this.flush()
    if (this.inFlight) await this.inFlight
    this.inFlight = null
  }

  /** 中止・失敗のとき: 溜めているぶんを捨て、送っている途中のぶんが終わるのを待つ(失敗は問わない) */
  async abandon(): Promise<void> {
    this.batch = []
    this.batchSize = 0
    await this.inFlight?.catch(() => {})
    this.inFlight = null
  }
}

/**
 * 画像の中身の鍵。SHA-256 と長さ(衝突は事実上起きないが、長さが違えば必ず別物になる)。
 * 1080p の PNG 1枚(約 65KB)で 0.1ms ほど。`crypto.subtle` の無い所(安全でない文脈)では
 * まとめない(中身そのものを鍵にすると、数万枚ぶんの画像を鍵として抱え込む)
 */
let uniqueKey = 0
async function digestKey(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return `unique:${uniqueKey++}`
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (const b of hash) hex += b.toString(16).padStart(2, '0')
  return `${bytes.byteLength}:${hex}`
}
