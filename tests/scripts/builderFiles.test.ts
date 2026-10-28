import { readdirSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * 製品に入れるファイル(electron-builder.cjs の files)。配布物を小さくするために外した物と、
 * 外してはいけない物(GPU の部品・実行時に読む物)を、electron-builder と同じ判定(app-builder-lib の FileMatcher)で確かめる。
 */
const root = join(__dirname, '..', '..')
const req = createRequire(__filename)
type Files = string[]
const builder = req(join(root, 'electron-builder.cjs')) as {
  files?: unknown
  electronLanguages: string[]
  win: { files: Files }
  linux: { files: Files }
  mac: { files: Files }
}
const { FileMatcher } = req('app-builder-lib/out/fileMatcher') as {
  FileMatcher: new (
    from: string,
    to: string,
    macroExpander: (s: string) => string,
    patterns: string[]
  ) => {
    prependPattern: (p: string) => void
    createFilter: () => (file: string, stat: { isDirectory: () => boolean }) => boolean
  }
}

/**
 * electron-builder が `${arch}` を CPU の名前にして、files で絞った後に残るか。
 * electron-builder と同じく、外されたフォルダの中には入らない(親のフォルダから順に確かめる。
 * node_modules そのものは別の手順で集めるので確かめない)
 */
function packs(files: Files, arch: string, rel: string): boolean {
  const m = new FileMatcher(root, join(root, 'dist-test'), (s) => s.replace(/\$\{arch\}/g, arch), [
    ...files
  ])
  m.prependPattern('**/*')
  const filter = m.createFilter()
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/')
    if (dir !== 'node_modules' && !filter(join(root, dir), { isDirectory: () => true }))
      return false
  }
  return filter(join(root, rel), { isDirectory: () => false })
}

const ORT = 'node_modules/onnxruntime-node/bin/napi-v6'
/** ffprobe は ffmpeg-static と同じリリースのもの(npm install がこの PC 用の 1 つだけを置く) */
const FFPROBE = 'node_modules/@derhuerst/ffprobe-static'
const LLAMA = 'node_modules/@node-llama-cpp'

/** どの OS でも入れる物(実行時に読む) */
const ALWAYS = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/renderer/assets/noto-sans-jp-0-400-normal-AbCdEf.woff2',
  'resources/models/face_detection_yunet_2023mar.onnx',
  'resources/THIRD_PARTY_NOTICES.txt',
  'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
  'node_modules/fluent-ffmpeg/lib/fluent-ffmpeg.js',
  'node_modules/ffmpeg-static/index.js',
  'node_modules/node-llama-cpp/dist/index.js',
  'node_modules/sharp/lib/index.js'
]
/** どの OS でも入れない物 */
const NEVER = [
  'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-0-400-normal.woff2',
  'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-0-400-normal.woff',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  'node_modules/protobufjs/dist/protobuf.js.map',
  'node_modules/fluent-ffmpeg/coverage/lcov.info',
  'tests/shared/product.test.ts',
  'docs/README.md',
  'BACKLOG.md',
  'src/main/index.ts',
  'scripts/release-check.cjs',
  'electron-builder.cjs'
]

describe('製品に入れるファイル(electron-builder.cjs の files)', () => {
  it('files は OS ごとにだけ書く(一番上にもあると、既定の除外が効かず .git・dist まで入る)', () => {
    expect(builder.files).toBeUndefined()
    for (const os of [builder.win, builder.linux, builder.mac])
      expect(os.files).toEqual(
        expect.arrayContaining(['!src/*', '!node_modules/@fontsource{,/**}'])
      )
  })

  it('どの OS でも、実行時に読む物は入れ、フォントの元・onnxruntime-web・試験・文書は入れない', () => {
    for (const [files, arch] of [
      [builder.win.files, 'x64'],
      [builder.linux.files, 'x64'],
      [builder.mac.files, 'arm64']
    ] as const) {
      for (const rel of ALWAYS) expect(packs(files, arch, rel), rel).toBe(true)
      for (const rel of NEVER) expect(packs(files, arch, rel), rel).toBe(false)
    }
  })

  it('Windows x64: DirectML(GPU)と CUDA・Vulkan の言語モデルの部品は残し、他の OS・CPU 用は外す', () => {
    const w = builder.win.files
    for (const keep of [
      `${ORT}/win32/x64/onnxruntime.dll`,
      `${ORT}/win32/x64/onnxruntime_binding.node`,
      `${ORT}/win32/x64/DirectML.dll`,
      `${ORT}/win32/x64/dxcompiler.dll`,
      `${ORT}/win32/x64/dxil.dll`,
      `${FFPROBE}/ffprobe.exe`,
      `${FFPROBE}/index.js`,
      `${LLAMA}/win-x64/bins/win-x64/llama-addon.node`,
      `${LLAMA}/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll`,
      `${LLAMA}/win-x64-cuda-ext/bins/win-x64-cuda/fallback/ggml-cuda.dll`,
      `${LLAMA}/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll`,
      'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll'
    ])
      expect(packs(w, 'x64', keep), keep).toBe(true)
    for (const drop of [
      `${ORT}/win32/arm64/onnxruntime.dll`,
      `${ORT}/linux/x64/libonnxruntime.so.1`,
      `${ORT}/linux/arm64/libonnxruntime.so.1`,
      `${ORT}/darwin/arm64/libonnxruntime.1.24.3.dylib`,
      `${LLAMA}/win-arm64/bins/win-arm64/llama-addon.node`,
      `${LLAMA}/linux-x64-cuda/bins/linux-x64-cuda/libggml-cuda.so`
    ])
      expect(packs(w, 'x64', drop), drop).toBe(false)
    // arm64 の Windows 用に作るときは arm64 の物を残す
    expect(packs(w, 'arm64', `${ORT}/win32/arm64/DirectML.dll`)).toBe(true)
    expect(packs(w, 'arm64', `${LLAMA}/win-arm64/bins/win-arm64/llama-addon.node`)).toBe(true)
    expect(packs(w, 'arm64', `${ORT}/win32/x64/DirectML.dll`)).toBe(false)
  })

  it('Linux x64: 言語モデルの CUDA・Vulkan は残し、onnxruntime の CUDA・TensorRT(Linux では使わない)と他の CPU 用は外す', () => {
    const l = builder.linux.files
    for (const keep of [
      `${ORT}/linux/x64/libonnxruntime.so.1`,
      `${ORT}/linux/x64/onnxruntime_binding.node`,
      `${ORT}/linux/x64/libonnxruntime_providers_shared.so`,
      `${FFPROBE}/ffprobe`,
      `${LLAMA}/linux-x64/bins/linux-x64/llama-addon.node`,
      `${LLAMA}/linux-x64-cuda/bins/linux-x64-cuda/libggml-cuda.so`,
      `${LLAMA}/linux-x64-cuda-ext/bins/linux-x64-cuda/fallback/libggml-cuda.so`,
      `${LLAMA}/linux-x64-vulkan/bins/linux-x64-vulkan/libggml-vulkan.so`,
      'node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3'
    ])
      expect(packs(l, 'x64', keep), keep).toBe(true)
    for (const drop of [
      `${ORT}/linux/x64/libonnxruntime_providers_cuda.so`,
      `${ORT}/linux/x64/libonnxruntime_providers_tensorrt.so`,
      `${ORT}/linux/arm64/libonnxruntime.so.1`,
      `${ORT}/darwin/arm64/libonnxruntime.1.24.3.dylib`,
      `${LLAMA}/linux-arm64/bins/linux-arm64/llama-addon.node`,
      `${LLAMA}/linux-armv7l/bins/linux-armv7l/llama-addon.node`,
      'node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.17.3'
    ])
      expect(packs(l, 'x64', drop), drop).toBe(false)
  })

  it('macOS: 他の OS 用は外すが、CPU では絞らない(universal で両方の CPU をまとめられるように)', () => {
    const m = builder.mac.files
    for (const keep of [
      `${ORT}/darwin/arm64/libonnxruntime.1.24.3.dylib`,
      `${FFPROBE}/ffprobe`,
      `${LLAMA}/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node`,
      `${LLAMA}/mac-x64/bins/mac-x64/llama-addon.node`
    ])
      expect(packs(m, 'x64', keep), keep).toBe(true)
    for (const drop of [`${ORT}/win32/x64/DirectML.dll`, `${LLAMA}/win-x64/x`])
      expect(packs(m, 'arm64', drop), drop).toBe(false)
  })

  it('Chromium のロケールは日本語と英語を入れる', () => {
    expect(builder.electronLanguages).toEqual(expect.arrayContaining(['ja', 'en-US']))
  })
})

describe('外した部品を実行時に読んでいない', () => {
  /** src の main・preload の .ts を全部読む */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [readFileSync(join(dir, e.name), 'utf-8')]
          : []
    )
  }

  it('main・preload は @fontsource・onnxruntime-web を読まない(フォントは画面のコードに入る)', () => {
    for (const text of [
      ...sources(join(root, 'src/main')),
      ...sources(join(root, 'src/preload'))
    ]) {
      expect(text).not.toMatch(
        /from ['"]@fontsource|import\(['"]@fontsource|require\(['"]@fontsource/
      )
      expect(text).not.toMatch(/['"]onnxruntime-web['"]/)
    }
  })

  it('@huggingface/transformers の Node 用は onnxruntime-web を読まない(onnxruntime-node を使う)', () => {
    const dist = join(root, 'node_modules/@huggingface/transformers/dist')
    for (const file of ['transformers.node.mjs', 'transformers.node.cjs']) {
      const text = readFileSync(join(dist, file), 'utf-8')
      expect(text).toMatch(/from ["']onnxruntime-node["']|require\(["']onnxruntime-node["']\)/)
      expect(text).not.toMatch(/from ["']onnxruntime-web["']|require\(["']onnxruntime-web["']\)/)
    }
  })
})
