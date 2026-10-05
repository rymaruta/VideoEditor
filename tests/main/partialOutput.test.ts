import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import { partialPathFor, writeViaPartial } from '../../src/main/partialOutput'

const dirs: string[] = []
const work = (): string => {
  const d = mkdtempSync(join(tmpdir(), 've-partial-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('書き出しは一時ファイルへ書いてから置き換える', () => {
  it('一時ファイルは同じフォルダ・同じ拡張子', () => {
    const p = partialPathFor('/out/番組 第1回.mp4')
    expect(p.startsWith('/out/')).toBe(true)
    expect(extname(p)).toBe('.mp4')
    expect(p).not.toBe('/out/番組 第1回.mp4')
  })

  it('成功したら本来の名前に置き換わる(前の完成品は上書き)', async () => {
    const d = work()
    const out = join(d, 'a.mp4')
    writeFileSync(out, 'old')
    await writeViaPartial(out, async (p) => writeFileSync(p, 'new'))
    expect(readFileSync(out, 'utf8')).toBe('new')
    expect(readdirSync(d)).toEqual(['a.mp4'])
  })

  it('失敗したら書きかけを消し、前の完成品は残す', async () => {
    const d = work()
    const out = join(d, 'a.mp4')
    writeFileSync(out, 'old')
    await expect(
      writeViaPartial(out, async (p) => {
        writeFileSync(p, 'half')
        throw new Error('EXPORT_CANCELED')
      })
    ).rejects.toThrow('EXPORT_CANCELED')
    expect(readFileSync(out, 'utf8')).toBe('old')
    expect(readdirSync(d)).toEqual(['a.mp4'])
  })

  it('前の完成品が無くて失敗したら、何も残さない', async () => {
    const d = work()
    const out = join(d, 'b.mp4')
    await expect(
      writeViaPartial(out, async (p) => {
        writeFileSync(p, 'half')
        throw new Error('ffmpeg failed')
      })
    ).rejects.toThrow()
    expect(existsSync(out)).toBe(false)
    expect(readdirSync(d)).toEqual([])
  })
})

describe('置き換えられないとき', () => {
  it('書き上げた動画は消さずに残し、その場所を伝える', async () => {
    const d = work()
    // 置き換え先がフォルダ(ファイルで上書きできない)
    const out = join(d, 'busy.mp4')
    mkdirSync(join(out, 'x'), { recursive: true })
    const err = await writeViaPartial(out, async (p) => writeFileSync(p, 'done')).catch(
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(Error)
    const left = readdirSync(d).filter((f) => f.includes('.partial-'))
    expect(left).toHaveLength(1)
    expect((err as Error).message).toContain(left[0])
    expect(readFileSync(join(d, left[0]), 'utf8')).toBe('done')
  }, 10_000)
})
