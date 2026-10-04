import { describe, expect, it } from 'vitest'
import { recordedAtFromTags, tagValue } from '../../src/shared/ingest/recordedAt'

/** 時差の記載が無い値は、その機材の現地時刻として読む */
const local = (y: number, mo: number, d: number, h: number, mi: number, s: number): number =>
  new Date(y, mo - 1, d, h, mi, s).getTime() / 1000

describe('recordedAtFromTags', () => {
  it('カメラの creation_time(日付と時刻)をそのまま読む', () => {
    expect(recordedAtFromTags({ creation_time: '2024-05-01T01:11:12.000000Z' })).toBe(
      Date.UTC(2024, 4, 1, 1, 11, 12) / 1000
    )
    expect(
      recordedAtFromTags({ 'com.apple.quicktime.creationdate': '2024-05-01T10:11:12+09:00' })
    ).toBe(Date.UTC(2024, 4, 1, 1, 11, 12) / 1000)
  })

  it('BWF の wav: 時刻だけの creation_time と date をつなげる', () => {
    expect(recordedAtFromTags({ creation_time: '10:11:12', date: '2024-05-01' })).toBe(
      local(2024, 5, 1, 10, 11, 12)
    )
  })

  it('BWF の origination_date / origination_time をつなげる(区切り記号の違いも読む)', () => {
    expect(
      recordedAtFromTags({ origination_date: '2024:05:01', origination_time: '10-11-12' })
    ).toBe(local(2024, 5, 1, 10, 11, 12))
    expect(recordedAtFromTags({ ORIGINATION_DATE: '2024/5/1', origination_time: '9:01:02' })).toBe(
      local(2024, 5, 1, 9, 1, 2)
    )
  })

  it('日付だけ・時刻だけでは「分からない」とする(0:00 と読むと同期を誤る)', () => {
    expect(recordedAtFromTags({ date: '2024-05-01' })).toBeUndefined()
    expect(recordedAtFromTags({ creation_time: '2024-05-01' })).toBeUndefined()
    expect(recordedAtFromTags({ creation_time: '10:11:12' })).toBeUndefined()
    expect(recordedAtFromTags({ date: '2024' })).toBeUndefined()
    expect(recordedAtFromTags({ creation_time: 'garbage' })).toBeUndefined()
    expect(recordedAtFromTags({})).toBeUndefined()
    expect(recordedAtFromTags(undefined)).toBeUndefined()
  })
})

describe('tagValue', () => {
  it('大文字小文字を区別せず、空の値は飛ばす', () => {
    expect(tagValue({ Make: ' ', MODEL: ' FX3 ' }, 'make', 'model')).toBe('FX3')
  })
})
