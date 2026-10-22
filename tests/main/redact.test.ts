import { describe, expect, it } from 'vitest'
import { buildBugReport, describeError, MAX_SANITIZE_CHARS, sanitizeLogText } from '@main/crashLog'

/**
 * 記録の伏せ字の漏れ。監査で漏れを探した46通り(再監査の redact.test.ts から取り込み)を、
 * どれも伏せることを確かめる。長い入力でも時間が伸びない(ReDoS が無い)ことも確かめる。
 */
const cases: [string, string][] = [
  ['plain AIza', 'key AIzaSyA1234567890abcdefghijklmnop'],
  ['AIza short (19)', 'AIzaSyA123456789012345'],
  ['url key', 'https://x/y?key=SECRET1&a=1'],
  ['url KEY upper', 'https://x/y?KEY=SECRET2'],
  ['url api_key', 'https://x/y?api_key=SECRET3'],
  ['url client_id', 'https://api.jamendo.com/v3.0/tracks?client_id=SECRET4&format=json'],
  ['url token freesound', 'https://freesound.org/apiv2/search/text/?query=a&token=SECRET5'],
  ['fragment access_token', 'https://x/cb#access_token=SECRET6&state=1'],
  ['urlencoded', 'https%3A%2F%2Fx%2Fy%3Fkey%3DSECRET7'],
  ['header colon', 'x-goog-api-key: SECRET8'],
  ['header Authorization Token', 'Authorization: Token SECRET9'],
  ['authorization lower bearer', 'authorization: bearer SECRET10'],
  ['bearer lowercase alone', 'sent bearer SECRET11xyz'],
  ['Bearer alone', 'Bearer SECRET12'],
  ['json key single quotes', "{'apiKey': 'SECRET13'}"],
  ['js object inspect', "{ apiKey: 'SECRET14', url: 'u' }"],
  ['json nested escaped', JSON.stringify({ m: JSON.stringify({ apiKey: 'SECRET15' }) })],
  [
    'json double nested',
    JSON.stringify({ m: JSON.stringify({ m: JSON.stringify({ token: 'SECRET16' }) }) })
  ],
  ['json value with backslash', JSON.stringify({ password: 'a\\"SECRET17' })],
  ['json api_key', '{"api_key":"SECRET18"}'],
  ['json youtubeApiKey', '{"youtubeApiKey":"SECRET19"}'],
  ['json freesound token num', '{"token":12345678}'],
  ['json authorization arr', '{"headers":[["Authorization","Bearer SECRET20"]]}'],
  ['json private_key', '{"private_key":"-----BEGIN PRIVATE KEY-----SECRET21"}'],
  ['json session', '{"sessionToken":"SECRET22"}'],
  ['json X-Goog-Api-Key', '{"X-Goog-Api-Key":"SECRET23"}'],
  ['env style', 'GEMINI_API_KEY=SECRET24'],
  ['env style2', 'VITE_GEMINI_API_KEY=SECRET25 YOUTUBE_API_KEY="SECRET26"'],
  ['key with space colon', 'apiKey: SECRET27'],
  ['url key after path no ?', 'https://x/y/key=SECRET28'],
  ['url key= in quotes', '"https://x?key=SECRET29"'],
  ['query & encoded amp', 'https://x?a=1&amp;key=SECRET30'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SECRET31sig'],
  ['google oauth ya29', 'ya29.a0SECRET32abcdefghijkl'],
  ['openai sk', 'sk-proj-SECRET33abcdefghijkl'],
  ['github ghp', 'ghp_SECRET34abcdefghijklmnopqrstuvwxyz12'],
  ['form body', 'body=client_id%3DX&client_secret%3DSECRET35'],
  ['key= after (', 'fetch(https://x?key=SECRET36)'],
  ['key= after tab-less colon', 'url:https://x?key=SECRET37'],
  ['json key with spaces in value', '{"key": "SECRET 38 with space"}'],
  ['Basic base64', 'Authorization: Basic U0VDUkVUMzk6cHc='],
  ['cookie', 'Cookie: SID=SECRET40; HSID=SECRET41'],
  ['set-cookie json', '{"set-cookie":"SID=SECRET42"}'],
  ['jamendo client_id json', '{"client_id":"SECRET43"}'],
  ['multiline JSON pretty', JSON.stringify({ apiKey: 'SECRET44' }, null, 2)],
  ['truncate split', 'x'.repeat(7990) + ' AIzaSyA1234567890abcdefghijklmnop']
]

const LEAK = /SECRET\d+|AIzaSyA1234|U0VDUkVU|eyJzdWIi/

describe('記録の伏せ字: 監査の46通り', () => {
  it.each(cases)('%s', (_name, input) => {
    expect(sanitizeLogText(input)).not.toMatch(LEAK)
  })

  it('伏せ字は鍵でないところを残す', () => {
    expect(sanitizeLogText('https://x/y?key=SECRET1&a=1')).toContain('&a=1')
    expect(sanitizeLogText("{ apiKey: 'SECRET14', url: 'u' }")).toContain("url: 'u'")
    expect(sanitizeLogText('{"file":"/v/a.mp4","token":"S"}')).toBe(
      '{"file":"/v/a.mp4","token":"***"}'
    )
    expect(sanitizeLogText('Cookie: SID=SECRET40; HSID=SECRET41\nnext line')).toContain(
      '\nnext line'
    )
  })

  it('例外のメッセージの鍵も伏せる', () => {
    const e = new Error('fetch https://x?key=SECRETY failed')
    expect(sanitizeLogText(describeError(e))).not.toContain('SECRETY')
  })
})

describe('記録の伏せ字: 長い入力でも時間が伸びない', () => {
  const variants: [string, string][] = [
    ['閉じないクォートの繰り返し', '"token":"a'.repeat(20000)],
    ['バックスラッシュの連続', '"token":"' + '\\'.repeat(200000)],
    ['長い文字', 'x'.repeat(2_000_000)],
    ['key= の繰り返し', ' key='.repeat(100000)],
    ['Authorization の繰り返し', 'Authorization: '.repeat(50000)],
    ['名前らしい文字の長い連なり', 'apikey'.repeat(200000) + ':'],
    ['区切りと名前の繰り返し', '?xkey'.repeat(200000)]
  ]
  it.each(variants)('%s', (_name, input) => {
    const t = Date.now()
    sanitizeLogText(input)
    // 手元では 1 回 数十ミリ秒。CI の遅い機械でも数秒に収まる(二乗で伸びると数分かかる)
    expect(Date.now() - t).toBeLessThan(process.env.CI ? 8000 : 3000)
  })
})
const leaks: [string, string][] = [
  ['form value after =', 'data=client_id%3DSECRET1'],
  ['token after =', 'x=token=SECRET2'],
  ['key in url path after @', 'https://user:SECRET3@host/x'],
  ['key after |', 'a|key=SECRET4'],
  ['key after >', '<key=SECRET5>'],
  ['header in array json-like', "['x-goog-api-key', 'SECRET6']"],
  ['map inspect', "Map(1) { 'apiKey' => 'SECRET7' }"],
  ['headers obj inspect Headers', "Headers { 'x-goog-api-key': 'SECRET8' }"],
  ['env quoted single', "GEMINI_API_KEY='SECRET9 x'"],
  ['yaml', 'apiKey:SECRET10'],
  ['tab sep', 'apiKey\tSECRET11'],
  ['equals space', 'apiKey = SECRET12'],
  ['set GEMINI', 'set GEMINI_API_KEY=SECRET13'],
  ['powershell', '$env:GEMINI_API_KEY="SECRET14"'],
  ['AIza in word', 'xAIzaSyA1234567890abcdef'],
  ['backtick', '`key=SECRET15`'],
  ['key with unicode delim', '鍵：key=SECRET16'],
  ['fullwidth', 'apiKey：SECRET17'],
  ['escaped single', "{\\'apiKey\\': \\'SECRET18\\'}"],
  ['newline in header value', 'Authorization:\n Bearer SECRET19'],
  ['key: then newline value', 'apiKey:\nSECRET20']
]
const normal: string[] = [
  "TypeError: Cannot read properties of undefined (reading 'key')",
  'Warning: Each child in a list should have a unique "key" prop.',
  'Error: Unexpected token: } at line 3',
  'SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
  'monkey: banana, path: /a/b',
  'hotkey: Ctrl+S failed; reason: busy',
  'keyframes=12 duration=3.5',
  'ffmpeg: [libx264] keyint=250 keyint_min=25',
  'at Object.<anonymous> (C:/app/out/main/index.js:10:5)',
  'Stream key: none, codec: h264',
  'Cookie consent: accepted\nnext line ok',
  '{"setCookie":true,"path":"/x"}',
  "{ secretsFile: '/x/secrets.json', size: 3 }",
  'tokenizer: loaded vocab 32000, layers: 28',
  'sig: SIGKILL code: null',
  'node-llama-cpp: keyCount=3 n_ctx=4096',
  'signal: SIGTERM, exitCode: null',
  'tokens: 512, tokensPerSecond: 12.3'
]
const timing3: [string, string][] = [
  ['bs run', '\\'.repeat(100000)],
  ['bs then key', '\\'.repeat(50000) + 'x'],
  ['bs quote', ('\\'.repeat(3) + '"').repeat(50000)],
  ['words', 'abcdefghij '.repeat(100000)],
  ['long ident', 'a'.repeat(200000)],
  ['long ident delim', ('/' + 'a'.repeat(1000)).repeat(200)],
  ['dash run', '-'.repeat(200000)],
  ['token: quote many', '"token": "'.repeat(50000)],
  ['token: bs quote', 'token: \\\\\\\\"'.repeat(30000)],
  ['dollar', '$'.repeat(200000)],
  ['ident nokey colon', ('a'.repeat(50) + ':').repeat(5000)],
  ['ident key-ish', ('ke'.repeat(500) + ' ').repeat(400)],
  ['cookie lines', 'cookie: x\n'.repeat(50000)]
]

describe('記録の伏せ字: 3回目の監査の取りこぼし21通り', () => {
  it.each(leaks)('%s', (_name, input) => {
    expect(sanitizeLogText(input)).not.toMatch(/SECRET\d+|1234567890abc/)
  })
})

describe('記録の伏せ字: 鍵でないものは変えない(伏せすぎない)', () => {
  it.each(normal.map((s) => [s]))('%s', (input) => {
    expect(sanitizeLogText(input)).toBe(input)
  })
})

describe('記録の伏せ字: 3回目の監査の長い入力・2MB の \\ でも時間が伸びない', () => {
  const big: [string, string][] = [
    ...timing3,
    ['2MB の \\', '\\'.repeat(2 * 1024 * 1024)],
    ['2MB の \\ と鍵', '"token":"' + '\\'.repeat(2 * 1024 * 1024)]
  ]
  it.each(big)('%s', (_name, input) => {
    const t = Date.now()
    sanitizeLogText(input)
    expect(Date.now() - t).toBeLessThan(process.env.CI ? 8000 : 2000)
  })

  it('長すぎる入力は先に切る(64KB)', () => {
    const out = sanitizeLogText('a'.repeat(MAX_SANITIZE_CHARS + 10))
    expect(out.length).toBeLessThan(MAX_SANITIZE_CHARS + 20)
    expect(out.endsWith('…(省略)')).toBe(true)
  })
})

describe('記録の伏せ字: 4回目の監査', () => {
  const slow: [string, (n: number) => string][] = [
    ['a.', (n) => 'a.'.repeat(n / 2)],
    ['a-', (n) => 'a-'.repeat(n / 2)],
    ['a+', (n) => 'a+'.repeat(n / 2)],
    ['x://a:', (n) => 'x://' + 'a:'.repeat(n / 2)],
    ['eyJa-', (n) => 'eyJaaaa-'.repeat(n / 8)],
    ['eyJ.', (n) => 'eyJaaaa.aaaa-'.repeat(n / 13)],
    ['A.', (n) => 'A.'.repeat(n / 2)]
  ]
  it.each(slow)('URL の user:password@・JWT の形が二乗にならない: %s', (_n, make) => {
    const s = make(MAX_SANITIZE_CHARS)
    const t = Date.now()
    sanitizeLogText(s)
    // 修正前は 64KB で約2秒
    expect(Date.now() - t).toBeLessThan(process.env.CI ? 3000 : 500)
  })

  const leaks: [string, string][] = [
    ['続け書き GEMINIAPIKEY', 'GEMINIAPIKEY=SECRETA1'],
    ['続け書き accesstoken', 'https://x/y?accesstoken=SECRETA2'],
    ['続け書き authtoken', 'authtoken: SECRETA3'],
    ['続け書き clientsecret', 'clientsecret=SECRETA4'],
    ['続け書き secretkey', 'secretkey=SECRETA5'],
    ['apiKeys', 'apiKeys: SECRETA6'],
    ['ACCESS_TOKEN_V2', 'ACCESS_TOKEN_V2=SECRETA7'],
    ['apiKey2', 'apiKey2=SECRETA8'],
    ['Cookie: true; SID=', 'Cookie: true; SID=SECRETA30'],
    ['Set-Cookie: 1; SID=', 'Set-Cookie: 1; SID=SECRETA31'],
    ['scheme の無い //user:pw@', '//user:SECRETA32@host'],
    ['パスワードに /', 'https://user:SEC/RETA33@host'],
    ['PEM の秘密鍵', 'privateKey: -----BEGIN PRIVATE KEY-----SECRETA39'],
    ['空の行をはさむ', 'apiKey:\n\nSECRETA44'],
    ['= の後の改行', 'apiKey=\nSECRETA45'],
    ['NBSP', 'apiKey:\u00a0SECRETA47'],
    ['全角の空白', 'apiKey\uFF1A\u3000SECRETA48'],
    ['全角の等号', 'apiKey\uFF1DSECRETA49'],
    ['(鍵)', 'apiKey: (SECRETA18)'],
    ['[鍵]', 'apiKey: [SECRETA19]'],
    ['{鍵}', 'apiKey={SECRETA20}'],
    ['\\ で始まる値', 'apiKey: \\SECRETA27'],
    ['改行と字下げ', "{\n  apiKey:\n    'SECRETA52'\n}"]
  ]
  it.each(leaks)('取りこぼさない: %s', (_n, input) => {
    expect(sanitizeLogText(input)).not.toMatch(/SECRETA\d+/)
  })

  const normal = [
    'Stream key: (none)',
    'cache key: thumbs/abc.png',
    'React key: clip-1',
    'shortcutKey: Ctrl+K, keyCode: 75',
    'publicKey: MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
    'sortKey=start&order=asc',
    'primaryKey: id',
    'monkey: a; hotkey: b; turkey: c',
    'secretary: Bob',
    'passwordless: true',
    'tokenized: yes',
    'keyboard: jp106',
    'keydown: ArrowLeft handled',
    'token count: 512',
    'keyint=250:min-keyint=25:scenecut=40',
    'llama_model_loader: - kv  20:      tokenizer.ggml.tokens arr[str,151936] = ["!", "\\"", "#"]',
    'llama_model_loader: - kv  23:   tokenizer.ggml.eos_token_id u32 = 151645',
    'Warning: React does not recognize the `apiKey` prop on a DOM element.',
    'Warning: %s: `key` is not a prop. Trying to access it will result in `undefined` being returned.',
    "TypeError: Cannot read properties of null (reading 'token')",
    'Error: Request failed with status code 403: {"error":{"code":403,"message":"API key not valid. Please pass a valid API key.","status":"PERMISSION_DENIED"}}',
    'http://localhost:5173/src/main.tsx?t=1700000000:12:3',
    'electron: --type=utility --utility-sub-type=node.mojom.NodeService --lang=ja --service-sandbox-type=none',
    '{"setCookie":true,"path":"/x"}'
  ]
  it.each(normal.map((s) => [s]))('鍵でないものは変えない: %s', (input) => {
    expect(sanitizeLogText(input)).toBe(input)
  })

  it('値がオブジェクトなら中の項目に任せ、形を崩さない', () => {
    expect(sanitizeLogText('{"credentials":{"private_key":"SECRETA38","type":"x"}}')).toBe(
      '{"credentials":{"private_key":"***","type":"x"}}'
    )
  })

  it('2回かけても同じ', () => {
    for (const c of [
      'apiKey: "S1"',
      'key=S2&x=1',
      'Cookie: SID=S3; HSID=S4',
      "{ 'x-goog-api-key': 'S5' }",
      'token: `S6`'
    ]) {
      const once = sanitizeLogText(c)
      expect(sanitizeLogText(once)).toBe(once)
    }
  })

  it('報告のまとめは全体で伏せる(行をまたぐ apiKey:\\n値、長い行の後ろの鍵)', () => {
    const r = buildBugReport(
      { os: 'Linux', cpu: 'x', cores: 4, memoryGb: 8, gpu: [], app: 'a' },
      { productName: 'P', version: '1', versions: {} },
      '2026 [main] x\n  apiKey:\n  SECRETB1\n  ' + 'a'.repeat(70000) + ' token=SECRETB2',
      1,
      { gpu_compositing: 'enabled' }
    )
    expect(r).not.toMatch(/SECRETB\d/)
  })
})
