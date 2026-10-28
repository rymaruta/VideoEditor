// インストーラの作り方(electron-builder)。もとは electron-builder.yml。
// 製品名・ID・販売者を src/shared/product.json の1か所から読むため、JS にした。
// 製品名を変えるときはこのファイルではなく product.json を直す。
/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('child_process')
const { join } = require('path')
const product = require('./src/shared/product.json')
const {
  assertReleasable,
  isDistributionBuild,
  linuxMaintainer
} = require('./scripts/release-check.cjs')
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 製品に入れない物(どの OS でも)。files は win・mac・linux の中にだけ書き、どれもこれに OS ごとの物を足す。
 * 一番上にも files を書くと、electron-builder(26.x)は上の files を別の組として扱い、その組には既定の除外
 * (.git・dist・build・package-lock.json など)を付けないので、リポジトリの中身と dist がまるごと app.asar に入る(実測)。
 * - 開発用の設定・スクリプト・ソース(src は out にビルドした物を入れる)
 * - @fontsource: フォントは画面のコード(out/renderer)に electron-vite が写して入れる。実行時に node_modules からは読まない
 *   (ライセンス表記は package.json の dependencies から作るので、ここで外しても表記には残る)
 * - onnxruntime-web: @huggingface/transformers の Node 用(transformers.node.*)は onnxruntime-node を使い、これを読まない
 * - node_modules の source map と、fluent-ffmpeg の試験の結果(coverage)・文書の生成の道具
 * - リポジトリの試験・文書・メモ・試験の設定
 */
const FILES = [
  '!**/.vscode/*',
  '!src/*',
  '!electron.vite.config.{js,ts,mjs,cjs}',
  '!electron-builder.cjs',
  '!scripts/*',
  '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
  '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
  '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}',
  '!node_modules/@fontsource{,/**}',
  '!node_modules/onnxruntime-web{,/**}',
  '!node_modules/**/*.map',
  '!node_modules/fluent-ffmpeg/{coverage,doc,OLD,tools}{,/**}',
  '!{tests,docs}{,/**}',
  '!{BACKLOG.md,vitest.config.ts,tsconfig.test.json}'
]

/**
 * ネイティブの部品のうち、作る OS・CPU で使わない物を外す(npm の包みに全 OS・全 CPU 用が入っている物がある)。
 * `${arch}` は electron-builder が作る CPU(x64・arm64 など)に置き換える。`!(...)` は「... 以外」。
 * - onnxruntime-node: bin/napi-v6/<OS>/<CPU>/ を全部の OS・CPU 分持っている。Windows の DirectML(GPU)の
 *   DirectML.dll・dxcompiler.dll・dxil.dll は win32/x64 の中にあり、そのまま入る
 * - @node-llama-cpp/<OS>-<CPU>[-cuda|-cuda-ext|-vulkan]: その OS・CPU の物は GPU 用(CUDA・Vulkan・Metal)も全部残す。
 *   win-arm64・linux-arm64 などは x64 の PC にも入る(package.json の cpu に x64 がある)が、x64 では動かない
 * ffmpeg・ffprobe(ffmpeg-static・@derhuerst/ffprobe-static)は npm install がこの PC 用の 1 つだけを落とすので、絞る物は無い
 * (前の ffprobe-static 3.x は全 OS・全 CPU 分の 4.0.2 を持っていて、ここで外していた)
 * @param {'win32' | 'linux' | 'darwin'} os onnxruntime-node の OS の名前
 * @param {'win' | 'linux' | 'mac'} llamaOs @node-llama-cpp の OS の名前
 * @param {boolean} byArch CPU でも絞るか(macOS は universal で両方の CPU を1つにまとめることがあるので絞らない)
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 型は上の JSDoc(.cjs のため)
function nativeExcludes(os, llamaOs, byArch) {
  const ort = 'node_modules/onnxruntime-node/bin/napi-v6'
  const llama = 'node_modules/@node-llama-cpp'
  return [
    `!${ort}/!(${os}){,/**}`,
    ...(byArch
      ? [
          `!${ort}/${os}/!(\${arch}){,/**}`,
          `!${llama}/!(${llamaOs}-\${arch}|${llamaOs}-\${arch}-*){,/**}`
        ]
      : [`!${llama}/!(${llamaOs}-*){,/**}`])
  ]
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: product.appId,
  productName: product.name,
  directories: {
    buildResources: 'build'
  },
  // files は OS ごと(win・mac・linux)に書く(FILES の説明)
  // Chromium の画面の文字(ロケール)は日本語と英語だけ入れる。アプリの画面は日本語で、Chromium の文字は
  // ほぼ出ない(独自のメニュー・ダイアログ)。他の言語の PC では Chromium の既定の言語が en-US になる
  electronLanguages: ['ja', 'en-US'],
  // resources/ には同梱のモデルと、ビルドのたびに作るライセンス表記
  // (resources/THIRD_PARTY_NOTICES.txt。npm run licenses)が入る
  asarUnpack: [
    'resources/**',
    'node_modules/ffmpeg-static/**',
    'node_modules/@derhuerst/ffprobe-static/**',
    'node_modules/onnxruntime-node/**',
    'node_modules/node-llama-cpp/**',
    'node_modules/@node-llama-cpp/**',
    'node_modules/sharp/**',
    'node_modules/@img/**'
  ],
  win: {
    executableName: product.name,
    files: [...FILES, ...nativeExcludes('win32', 'win', true)]
  },
  nsis: {
    // 持ち主の PC で試す版は名前で分かるようにする(配布用と取り違えない)
    artifactName:
      process.env.VE_PERSONAL_BUILD === '1'
        ? '${productName}-${version}-personal-setup.${ext}'
        : '${productName}-${version}-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  mac: {
    files: [...FILES, ...nativeExcludes('darwin', 'mac', false)],
    entitlementsInherit: 'build/entitlements.mac.plist',
    // 日本語と英語を改行でつなぐ。素材・書き出し先は書類・ダウンロード・デスクトップ・外付けのドライブにあることが多い。
    // カメラ・マイクは使わないので求めない
    extendInfo: {
      NSDocumentsFolderUsageDescription: [
        '書類フォルダにある動画・音声の素材を読み込み、編集した動画やプロジェクトを保存するために使います。',
        'Used to import video and audio from your Documents folder and to save edited videos and projects there.'
      ].join('\n'),
      NSDownloadsFolderUsageDescription: [
        'ダウンロードフォルダにある動画・音声の素材を読み込み、編集した動画を保存するために使います。',
        'Used to import video and audio from your Downloads folder and to save edited videos there.'
      ].join('\n'),
      NSDesktopFolderUsageDescription: [
        'デスクトップにある動画・音声の素材を読み込み、編集した動画やプロジェクトを保存するために使います。',
        'Used to import video and audio from your Desktop and to save edited videos and projects there.'
      ].join('\n'),
      NSRemovableVolumesUsageDescription: [
        '外付けのドライブ・SD カードにある撮影素材を読み込み、編集した動画を保存するために使います。',
        'Used to import footage from external drives and SD cards and to save edited videos there.'
      ].join('\n'),
      NSNetworkVolumesUsageDescription: [
        'ネットワーク上のフォルダにある撮影素材を読み込み、編集した動画を保存するために使います。',
        'Used to import footage from network folders and to save edited videos there.'
      ].join('\n')
    },
    notarize: false
  },
  dmg: {
    artifactName: '${productName}-${version}.${ext}'
  },
  linux: {
    target: ['AppImage', 'snap', 'deb'],
    // Linux では onnxruntime を CPU だけで使う(asrDeviceOrder・eventWorker)。npm の install が取ってくる
    // CUDA・TensorRT の部品(約 310MB)は読まれない。Electron は musl の Linux では動かないので musl 用も外す
    files: [
      ...FILES,
      ...nativeExcludes('linux', 'linux', true),
      '!node_modules/onnxruntime-node/bin/napi-v6/linux/*/libonnxruntime_providers_{cuda,tensorrt}.so',
      '!node_modules/@img/*linuxmusl*{,/**}',
      '!node_modules/@reflink/*musl*{,/**}'
    ],
    // product.json の vendor と連絡先。連絡先(vendorEmail)が無ければ製品の URL(homepage)を使う
    // (例: VideoEditor <https://github.com/rymaruta/VideoEditor>)
    maintainer: linuxMaintainer(product),
    category: 'Utility'
  },
  appImage: {
    artifactName: '${productName}-${version}.${ext}'
  },
  npmRebuild: false,
  // 同梱する部品のライセンス表記を、詰める直前に node_modules から作り直す(古い表記・表記なしで出さない)。
  // 配布用の出力(--dir 以外)なら、販売者・GPL のソースの入手先が未定のままでは止める
  // (scripts/release-check.cjs。npm の build:win などは先にも検査して、長いビルドの前に止める)
  beforePack: (context) => {
    // VE_PERSONAL_BUILD=1 は持ち主の PC で試すための版(配布しない)。販売者などの検査は掛けない
    if (isDistributionBuild(context && context.targets) && process.env.VE_PERSONAL_BUILD !== '1')
      assertReleasable(__dirname)
    execFileSync(process.execPath, [join(__dirname, 'scripts', 'third-party-notices.mjs')], {
      stdio: 'inherit'
    })
  },
  publish: {
    provider: 'generic',
    url: 'https://example.com/auto-updates'
  }
}
