// 配布用のビルド(build:win・build:mac・build:linux、electron-builder のインストーラ)の前の検査。
// 販売者(vendor)・連絡先(vendorEmail)・GPL のソースの入手先(sourceOfferUrl)が未定(TBD)のままなら止める。
// 開発用のビルド(npm run build・build:unpack = electron-builder --dir)は止めない。
//
// 使い方: node scripts/release-check.cjs   (止めるときは理由を出して終了コード 1)
// electron-builder.cjs の beforePack からも呼ばれる(--dir 以外の出力を作るとき)。
//
// 「未定」の判定は src/shared/product.ts の isPlaceholder と同じ(試験 tests/scripts/releaseCheck.test.ts が
// 同じ答えになることを確かめる)。
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { readFileSync } = require('fs')
const { join } = require('path')

/** 未定の値(`TBD`・空・example の宛先) */
function isPlaceholder(value) {
  const v = String(value ?? '').trim()
  return (
    v === '' ||
    /^tbd$/i.test(v) ||
    /(^|[@.])example\.(invalid|com|org|net)$/i.test(v) ||
    /^https?:\/\/([^/]+\.)?example\.(invalid|com|org|net)(\/|$)/i.test(v)
  )
}

/** 配布してよいかの問題点(空なら配布してよい) */
function releaseProblems(product) {
  const problems = []
  const p = product ?? {}
  if (isPlaceholder(p.vendor))
    problems.push('販売者(product.json の vendor)が未定です。法的な名義を入れてください')
  if (isPlaceholder(p.vendorEmail))
    problems.push(
      '販売者の連絡先(product.json の vendorEmail)が未定です。GPL のソースの提供の申し出の宛先になります'
    )
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.vendorEmail).trim()))
    problems.push(`販売者の連絡先(vendorEmail)がメールの宛先の形ではありません: ${p.vendorEmail}`)
  if (isPlaceholder(p.sourceOfferUrl))
    problems.push(
      'GPL のソースの入手先(product.json の sourceOfferUrl)が未定です。npm run gpl-sources で作った一式を置く URL を入れてください(docs/GPL_COMPLIANCE.md)'
    )
  else if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(String(p.sourceOfferUrl).trim()))
    problems.push(
      `GPL のソースの入手先(sourceOfferUrl)が https の URL ではありません: ${p.sourceOfferUrl}`
    )
  return problems
}

/** electron-builder の出力先(context.targets)が配布用か。--dir(展開しただけ)だけなら開発用 */
function isDistributionBuild(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return false
  return targets.some((t) => {
    const name = typeof t === 'string' ? t : t?.name
    return typeof name === 'string' && name !== 'dir'
  })
}

function readProduct(projectDir) {
  return JSON.parse(readFileSync(join(projectDir, 'src', 'shared', 'product.json'), 'utf-8'))
}

/** 問題があれば例外にする(electron-builder の beforePack から) */
function assertReleasable(projectDir) {
  const problems = releaseProblems(readProduct(projectDir))
  if (problems.length > 0)
    throw new Error(
      `配布用のビルドを止めました(開発用は npm run build:unpack):\n  - ${problems.join('\n  - ')}`
    )
}

module.exports = { isPlaceholder, releaseProblems, isDistributionBuild, assertReleasable }

if (require.main === module) {
  try {
    assertReleasable(join(__dirname, '..'))
    console.log('配布用のビルドの検査: 販売者・連絡先・ソースの入手先は決まっています')
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
