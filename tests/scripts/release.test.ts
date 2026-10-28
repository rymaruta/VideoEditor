import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILD_KIND_KEY } from '@main/autoUpdate'
import {
  envCheckProblems,
  expectedPackagedFiles,
  probeProblems,
  updateConfigProblems
} from '../../scripts/smoke-electron.mjs'

/**
 * 正式リリース(.github/workflows/release.yml)の部品: タグと版の検査、自動更新の行き先(electron-builder.cjs の
 * publish)、持ち主が試す版(VE_PERSONAL_BUILD=1)との違い、起動の試験(scripts/smoke-electron.mjs)の判定。
 */
const root = join(__dirname, '..', '..')
const req = createRequire(__filename)
const version = req(join(root, 'scripts', 'release-version.cjs')) as {
  normalizeTag: (t: unknown) => string
  releaseTagProblems: (tag: unknown, version: unknown) => string[]
  isPrerelease: (v: unknown) => boolean
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

interface BuilderConfig {
  publish: unknown
  extraMetadata: Record<string, unknown>
  nsis: { artifactName: string }
}
const builderPath = join(root, 'electron-builder.cjs')
/** electron-builder.cjs は読み込んだときの VE_PERSONAL_BUILD で決まるので、そのたびに読み直す */
function loadBuilder(personal: boolean): BuilderConfig {
  const saved = process.env.VE_PERSONAL_BUILD
  if (personal) process.env.VE_PERSONAL_BUILD = '1'
  else delete process.env.VE_PERSONAL_BUILD
  try {
    delete req.cache[req.resolve(builderPath)]
    return req(builderPath) as BuilderConfig
  } finally {
    if (saved === undefined) delete process.env.VE_PERSONAL_BUILD
    else process.env.VE_PERSONAL_BUILD = saved
  }
}
afterEach(() => {
  delete req.cache[req.resolve(builderPath)]
})

describe('正式リリース: タグと package.json の version', () => {
  it('v<version> のタグなら通す(refs/tags/ 付きでもよい)', () => {
    expect(version.releaseTagProblems('v1.2.0', '1.2.0')).toEqual([])
    expect(version.releaseTagProblems('refs/tags/v1.2.0', '1.2.0')).toEqual([])
    expect(version.releaseTagProblems('v1.3.0-beta.1', '1.3.0-beta.1')).toEqual([])
    expect(version.normalizeTag(' refs/tags/v2.0.0 ')).toBe('v2.0.0')
  })

  it('食い違う・v が無い・空・版の形でないなら止める', () => {
    expect(version.releaseTagProblems('v1.2.1', '1.2.0')[0]).toMatch(/合いません/)
    expect(version.releaseTagProblems('1.2.0', '1.2.0')[0]).toMatch(/v で始め/)
    expect(version.releaseTagProblems('', '1.2.0')[0]).toMatch(/タグがありません/)
    expect(version.releaseTagProblems('v1.2', '1.2')[0]).toMatch(/版の形/)
    expect(version.releaseTagProblems('vlatest', 'latest')[0]).toMatch(/版の形/)
    expect(version.releaseTagProblems('v01.2.0', '01.2.0')[0]).toMatch(/版の形/)
  })

  it('- の付いた版はプレリリース(自動更新では正式版の利用者に配らない)', () => {
    expect(version.isPrerelease('1.3.0-beta.1')).toBe(true)
    expect(version.isPrerelease('1.3.0')).toBe(false)
  })

  it('いまの package.json の version は v<version> のタグで出せる', () => {
    expect(version.releaseTagProblems(`v${pkg.version}`, pkg.version)).toEqual([])
  })
})

describe('自動更新の行き先(electron-builder.cjs の publish)', () => {
  it('正式版は GitHub の Releases(rymaruta/VideoEditor)を指し、印は release', () => {
    const b = loadBuilder(false)
    expect(b.publish).toEqual({ provider: 'github', owner: 'rymaruta', repo: 'VideoEditor' })
    expect(b.extraMetadata[BUILD_KIND_KEY]).toBe('release')
    expect(b.nsis.artifactName).toBe('${productName}-${version}-setup.${ext}')
  })

  it('持ち主が試す版は行き先を入れず(app-update.yml を作らない)、印は personal', () => {
    const b = loadBuilder(true)
    expect(b.publish).toBeNull()
    expect(b.extraMetadata[BUILD_KIND_KEY]).toBe('personal')
    expect(b.nsis.artifactName).toContain('-personal-setup')
  })

  it('どの版も例の仮の URL(example.com)を見に行かない', () => {
    for (const personal of [false, true])
      expect(JSON.stringify(loadBuilder(personal).publish ?? null)).not.toMatch(/example\./)
    expect(readFileSync(builderPath, 'utf-8')).not.toMatch(/example\.com/)
  })

  it('electron-updater は製品に入る依存(dependencies)、Playwright は開発用。どちらも版を固定', () => {
    expect(pkg.dependencies['electron-updater']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.devDependencies['playwright-core']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.dependencies['playwright-core']).toBeUndefined()
  })
})

describe('起動の試験(smoke-electron.mjs)の判定', () => {
  it('Windows の製品には ffmpeg・ffprobe・onnxruntime と DirectML の DLL・表記が入っているはず', () => {
    const files = expectedPackagedFiles('win32', 'x64')
    expect(files).toContain('app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe')
    expect(files).toContain(
      'app.asar.unpacked/node_modules/@derhuerst/ffprobe-static/ffprobe.exe'
    )
    expect(files).toContain(
      'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/DirectML.dll'
    )
    expect(files).toContain('app.asar.unpacked/resources/THIRD_PARTY_NOTICES.txt')
    expect(expectedPackagedFiles('linux', 'x64').some((f) => f.endsWith('.dll'))).toBe(false)
  })

  it('自動更新の行き先: 正式版は GitHub、personal は無いこと', () => {
    const good =
      'owner: rymaruta\nrepo: VideoEditor\nprovider: github\nupdaterCacheDirName: video-editor-updater\n'
    expect(updateConfigProblems('release', good)).toEqual([])
    expect(updateConfigProblems('release', null)[0]).toMatch(/ありません/)
    expect(
      updateConfigProblems('release', 'provider: generic\nurl: https://example.com/auto-updates\n')
        .length
    ).toBeGreaterThanOrEqual(2)
    expect(updateConfigProblems('personal', null)).toEqual([])
    expect(updateConfigProblems('personal', good)[0]).toMatch(/personal/)
    expect(updateConfigProblems(undefined, null)).toEqual([])
  })

  const okEnv = {
    ffmpeg: { version: '6.1.1-essentials_build-www.gyan.dev', encoders: [] },
    speed: [{ encoder: 'libx264', seconds: 4.2, speed: 2.4 }],
    whisper: {
      order: ['dml', 'cpu'],
      backends: ['cpu', 'dml', 'webgpu'],
      model: 'm',
      downloaded: false
    },
    localAi: { ok: true, device: 'vulkan' }
  }

  it('環境チェック: ffmpeg が動き・onnxruntime(Windows は DirectML も)と node-llama-cpp を読めれば OK', () => {
    expect(envCheckProblems(okEnv, 'win32')).toEqual([])
    expect(
      envCheckProblems({ ...okEnv, whisper: { ...okEnv.whisper, backends: ['cpu'] } }, 'linux')
    ).toEqual([])
  })

  it('環境チェック: 部品が読めなければ挙げる', () => {
    expect(envCheckProblems(null, 'win32')).toHaveLength(1)
    expect(envCheckProblems({ ...okEnv, ffmpeg: { version: '' } }, 'win32')[0]).toMatch(/ffmpeg/)
    expect(
      envCheckProblems(
        { ...okEnv, speed: [{ encoder: 'libx264', seconds: null, speed: null, error: 'x' }] },
        'win32'
      )[0]
    ).toMatch(/x264/)
    const noOrt = envCheckProblems(
      { ...okEnv, whisper: { ...okEnv.whisper, backends: [], error: 'DLL load failed' } },
      'win32'
    )
    expect(noOrt.join('\n')).toMatch(/onnxruntime を読み込めません: DLL load failed/)
    expect(noOrt.join('\n')).toMatch(/DirectML/)
    expect(
      envCheckProblems({ ...okEnv, localAi: { ok: false, error: 'no binding' } }, 'win32')[0]
    ).toMatch(/node-llama-cpp/)
  })

  it('probeMedia: 1 秒の映像と音声を読めれば OK', () => {
    expect(probeProblems({ hasVideo: true, hasAudio: true, duration: 1.02 })).toEqual([])
    expect(probeProblems({ hasVideo: false, hasAudio: true, duration: 1 })).toHaveLength(1)
    expect(probeProblems({ hasVideo: true, hasAudio: true, duration: 0 })[0]).toMatch(/尺/)
    expect(probeProblems(undefined)).toHaveLength(1)
  })
})
