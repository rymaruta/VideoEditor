// 正式リリース(.github/workflows/release.yml)の最初の検査: タグと package.json の version が合うか。
// タグは `v<version>`(例: package.json が 1.2.0 なら v1.2.0)。合わなければ止める(インストーラ・latest.yml の
// 版とリリースの名前が食い違うと、自動更新が正しく働かない)。
//
// 使い方: node scripts/release-version.cjs <タグ>   (合わなければ理由を出して終了コード 1)
// GITHUB_OUTPUT があれば version・tag・prerelease(版に - があるか。1.2.0-beta.1 など)を書く。
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { appendFileSync, readFileSync } = require('fs')
const { join } = require('path')

/** semver の版(1.2.3・1.2.3-beta.1。+ のビルドの印は使わない) */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

/** タグを refs/tags/ 付きでも受け取る */
function normalizeTag(tag) {
  return String(tag ?? '')
    .trim()
    .replace(/^refs\/tags\//, '')
}

/** タグと版の問題点(空なら合っている) */
function releaseTagProblems(tag, version) {
  const t = normalizeTag(tag)
  const v = String(version ?? '').trim()
  const problems = []
  if (!VERSION.test(v))
    problems.push(`package.json の version が版の形(1.2.3)ではありません: ${v || '(空)'}`)
  if (!t)
    problems.push('タグがありません(v1.2.3 の形のタグを push するか、実行するときにタグを選ぶ)')
  else if (!/^v/.test(t)) problems.push(`タグは v で始めます(v1.2.3): ${t}`)
  else if (t !== `v${v}`)
    problems.push(
      `タグ ${t} と package.json の version ${v} が合いません。package.json を ${t.slice(1)} にしてコミットし、そのコミットにタグを付け直してください`
    )
  return problems
}

/** プレリリースか(1.2.0-beta.1 など。自動更新では正式版の利用者に配らない) */
function isPrerelease(version) {
  return String(version ?? '').includes('-')
}

module.exports = { normalizeTag, releaseTagProblems, isPrerelease }

if (require.main === module) {
  const tag = normalizeTag(process.argv[2] ?? process.env.GITHUB_REF ?? '')
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
  const problems = releaseTagProblems(tag, pkg.version)
  if (problems.length > 0) {
    console.error(`正式リリースを止めました:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }
  console.log(`タグ ${tag} と package.json の version ${pkg.version} は合っています`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${pkg.version}\ntag=${tag}\nprerelease=${isPrerelease(pkg.version)}\n`
    )
}
