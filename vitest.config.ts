import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/**
 * テストの走らせ方。**厳しさはここで担保する。**
 *
 * - `tests/**` に置いた `*.test.ts` を全部走らせる。
 * - `bail: 0` ——1件落ちても最後まで走らせて、落ちた数を全部見せる
 *   (最初の1件で止めると「他にも落ちている」ことが分からない)。
 * - **タイムアウトは短め**。純関数のテストしか置かないので、
 *   秒単位かかるものが混ざったらそれ自体が設計の異常。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    bail: 0,
    testTimeout: 10000,
    hookTimeout: 10000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts', 'src/renderer/src/lib/**/*.ts'],
      reporter: ['text-summary']
    }
  }
})
