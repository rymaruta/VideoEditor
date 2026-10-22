import { describe, expect, it } from 'vitest'
import { describeError, sanitizeLogText } from '@main/crashLog'

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
