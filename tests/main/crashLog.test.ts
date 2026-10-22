import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBugReport,
  CrashLog,
  describeError,
  logFileName,
  RateLimiter,
  sanitizeLogText
} from '@main/crashLog'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 've-crashlog-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('不具合の記録: 日付ごとのファイルと回転', () => {
  it('その PC の日付でファイルを分ける', () => {
    expect(logFileName(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05.log')
    expect(logFileName(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31.log')
  })

  it('日が替わると新しいファイルに書き、古いものは数を限って消す(ほかのファイルは触らない)', () => {
    const dir = tempDir()
    let day = new Date(2026, 9, 1, 12)
    const log = new CrashLog({ dir, keepFiles: 3, now: () => day })
    writeFileSync(join(dir, 'メモ.txt'), '利用者のファイル')
    for (let i = 0; i < 6; i++) {
      day = new Date(2026, 9, 1 + i, 12)
      log.write('main', `起きたこと ${i}`)
    }
    const files = readdirSync(dir).sort()
    expect(files).toEqual(['2026-10-04.log', '2026-10-05.log', '2026-10-06.log', 'メモ.txt'])
    expect(readFileSync(join(dir, '2026-10-06.log'), 'utf-8')).toContain('[main] 起きたこと 5')
  })

  it('起動したときにも古いものを片付ける', () => {
    const dir = tempDir()
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'])
      writeFileSync(join(dir, `${d}.log`), 'x\n')
    const log = new CrashLog({ dir, keepFiles: 2, now: () => new Date(2026, 0, 4, 9) })
    log.write('main', '起動')
    expect(readdirSync(dir).sort()).toEqual(['2026-01-03.log', '2026-01-04.log'])
  })

  it('1日のファイルが上限に達したら、以降は省くと1回だけ書く', () => {
    const dir = tempDir()
    const now = new Date(2026, 4, 1, 10)
    writeFileSync(join(dir, logFileName(now)), 'x'.repeat(2 * 1024 * 1024))
    const log = new CrashLog({ dir, now: () => now })
    log.write('renderer', 'a')
    log.write('renderer', 'b')
    const text = readFileSync(join(dir, logFileName(now)), 'utf-8')
    expect(text.match(/以降は省きます/g)).toHaveLength(1)
    expect(text).not.toContain('[renderer] a')
  })

  it('書けない場所でも投げない(アプリを止めない)', () => {
    const dir = tempDir()
    const file = join(dir, 'file')
    writeFileSync(file, '')
    const log = new CrashLog({ dir: join(file, 'logs') })
    expect(() => log.write('main', 'x', new Error('y'))).not.toThrow()
    expect(log.files()).toEqual([])
    expect(log.recent()).toBe('')
  })

  it('直近の記録を、古い順に上限まで返す', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '2026-02-01.log'), 'old\n')
    writeFileSync(join(dir, '2026-02-02.log'), 'new\n')
    const log = new CrashLog({ dir })
    const text = log.recent()
    expect(text.indexOf('2026-02-01.log')).toBeLessThan(text.indexOf('2026-02-02.log'))
    const short = log.recent(3)
    expect(short).toContain('2026-02-02.log')
    expect(short).not.toContain('2026-02-01.log')
  })
})

describe('不具合の記録: 書かないもの', () => {
  it('ホームフォルダを ~ にする(Windows の区切り・大文字小文字の違いも)', () => {
    expect(sanitizeLogText('open /home/alice/videos/a.mp4 failed', '/home/alice')).toBe(
      'open ~/videos/a.mp4 failed'
    )
    expect(
      sanitizeLogText('C:\\Users\\Alice\\Videos\\a.mp4 と c:/users/alice/x', 'C:\\Users\\Alice')
    ).toBe('~\\Videos\\a.mp4 と ~/x')
    // 名前が前方一致するだけの別のフォルダは変えない
    expect(sanitizeLogText('/home/alice2/a', '/home/alice')).toBe('/home/alice2/a')
  })

  it('URL の鍵・Google の API キーの形を伏せる', () => {
    const text = sanitizeLogText(
      'GET https://generativelanguage.googleapis.com/v1beta/x?key=AIzaSyA1234567890abcdefghijklmnop&alt=1 ' +
        'https://api.jamendo.com/v3.0/tracks?client_id=abcd1234&q=x ' +
        'Authorization: Token secret123 AIzaSyZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'
    )
    expect(text).not.toMatch(/AIzaSy[A-Z0-9]/i)
    expect(text).not.toContain('abcd1234')
    expect(text).not.toContain('secret123')
    expect(text).toContain('key=***&alt=1')
    expect(text).toContain('client_id=***&q=x')
  })

  it('記録にもホームフォルダ・鍵が残らず、長すぎる1件は切る', () => {
    const dir = tempDir()
    const now = new Date(2026, 6, 7, 8)
    const log = new CrashLog({ dir, home: '/home/bob', now: () => now })
    const e = new Error(
      'ENOENT: /home/bob/素材/clip.mp4?key=AIzaSyQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'
    )
    log.write('main', '未処理の例外', e)
    log.write('renderer', '長い', 'x'.repeat(20000))
    const text = readFileSync(join(dir, logFileName(now)), 'utf-8')
    expect(text).toContain('~/素材/clip.mp4')
    expect(text).not.toContain('/home/bob')
    expect(text).not.toContain('AIzaSyQ')
    expect(text).toContain('…(省略)')
    expect(text.length).toBeLessThan(12000)
  })

  it('例外の名前・コード・スタックの先頭を書く', () => {
    const e = Object.assign(new Error('boom'), { code: 'EPERM' })
    const text = describeError(e)
    expect(text.startsWith('Error (EPERM): boom')).toBe(true)
    expect(text.split('\n').length).toBeLessThanOrEqual(16)
    expect(describeError({ a: 1 })).toBe('{"a":1}')
    expect(describeError('s')).toBe('s')
  })
})

describe('不具合の記録: 画面からの記録の上限と、報告のまとめ', () => {
  it('決まった時間に決まった数まで通す', () => {
    const r = new RateLimiter(2, 1000)
    expect([r.take(0), r.take(10), r.take(20)]).toEqual([true, true, false])
    expect(r.take(1011)).toBe(true)
  })

  it('報告には版・OS・GPU・直近の記録が入り、自動で送らないことと中身を書く', () => {
    const text = buildBugReport(
      { os: 'Linux 6', cpu: 'CPU X', cores: 8, memoryGb: 16, gpu: ['GPU Y'], app: 'a' },
      {
        productName: 'Prod',
        version: '1.2.3',
        versions: { electron: '39', chrome: '140', node: '22' }
      },
      '2026-01-01T00:00:00Z [main] 起きたこと /home/carol/a.mp4',
      3.25,
      { gpu_compositing: 'enabled' },
      '/home/carol',
      new Date('2026-01-02T00:00:00Z')
    )
    expect(text).toContain('Prod 1.2.3')
    expect(text).toContain('Electron 39 / Chromium 140')
    expect(text).toContain('OS: Linux 6')
    expect(text).toContain('空き 3.3 GB')
    expect(text).toContain('GPU Y')
    expect(text).toContain('gpu_compositing: enabled')
    expect(text).toContain('自動では送られません')
    expect(text).toContain('~/a.mp4')
    expect(text).not.toContain('/home/carol')
  })

  it('記録が無くても作れる', () => {
    const text = buildBugReport(
      { os: 'o', cpu: 'c', cores: 1, memoryGb: 1, gpu: [], app: 'a' },
      { productName: 'P', version: '1', versions: {} },
      '',
      1,
      {}
    )
    expect(text).toContain('(記録はありません)')
    expect(text).toContain('(取得できませんでした)')
    expect(existsSync('/nonexistent')).toBe(false)
  })
})
