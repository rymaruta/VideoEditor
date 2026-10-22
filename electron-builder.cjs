// インストーラの作り方(electron-builder)。もとは electron-builder.yml。
// 製品名・ID・販売者を src/shared/product.json の1か所から読むため、JS にした。
// 製品名を変えるときはこのファイルではなく product.json を直す。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const product = require('./src/shared/product.json')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: product.appId,
  productName: product.name,
  directories: {
    buildResources: 'build'
  },
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!electron-builder.cjs',
    '!scripts/*',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  ],
  // resources/ には同梱のモデルと、ビルドのたびに作るライセンス表記
  // (resources/THIRD_PARTY_NOTICES.txt。npm run licenses)が入る
  asarUnpack: [
    'resources/**',
    'node_modules/ffmpeg-static/**',
    'node_modules/ffprobe-static/**',
    'node_modules/onnxruntime-node/**',
    'node_modules/node-llama-cpp/**',
    'node_modules/@node-llama-cpp/**',
    'node_modules/sharp/**',
    'node_modules/@img/**'
  ],
  win: {
    executableName: product.name
  },
  nsis: {
    artifactName: '${name}-${version}-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  mac: {
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
    artifactName: '${name}-${version}.${ext}'
  },
  linux: {
    target: ['AppImage', 'snap', 'deb'],
    // 販売者が決まったら product.json の vendor / vendorEmail を直す
    maintainer: `${product.vendor} <${product.vendorEmail}>`,
    category: 'Utility'
  },
  appImage: {
    artifactName: '${name}-${version}.${ext}'
  },
  npmRebuild: false,
  publish: {
    provider: 'generic',
    url: 'https://example.com/auto-updates'
  }
}
