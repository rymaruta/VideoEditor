import { describe, expect, it } from 'vitest'
import { ffSeconds } from '../../src/main/ffArgs'

describe('ffSeconds — ffmpeg に渡す秒', () => {
  it('丸めの残り・負・数でない値は 0、ほかは小数6桁(指数で書かない)', () => {
    expect(ffSeconds(0.1 + 0.2 - 0.3)).toBe('0')
    expect(ffSeconds(-5e-7)).toBe('0')
    expect(ffSeconds(Number.NaN)).toBe('0')
    expect(ffSeconds(1.5)).toBe('1.500000')
    expect(ffSeconds(1e-7 + 3)).toBe('3.000000')
    expect(ffSeconds(1e21)).not.toMatch(/e/)
  })
})
