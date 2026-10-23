import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  EnvCheckBusyError,
  withTimeout,
  checkEncoders,
  measureSpeed,
  redactResult,
  runEnvCheck,
  spawnFfmpeg,
  speedArgs,
  trialArgs,
  type FfmpegRunner
} from '@main/envCheck'
import {
  asrBackendView,
  envCheckErrorMessage,
  buildEnvCheckReport,
  envCheckFileName,
  envCheckSections,
  fastestEncoder,
  gpuDevicesFromInfo,
  judgeLocalAi,
  lastErrorLine,
  parseEncoderList,
  type EnvCheckProgress
} from '@shared/envCheck'
import { buildMenuTemplate } from '@shared/appMenu'

const tmp = mkdtempSync(join(tmpdir(), 've-envcheck-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const ENCODERS_OUT = [
  'Encoders:',
  ' V..... = Video',
  ' ------',
  ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
  ' V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)',
  ' V..... h264_qsv             H.264 / AVC / MPEG-4 AVC (Intel Quick Sync Video acceleration) (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)'
].join('\n')

/** 偽の ffmpeg: NVENC の H.264 だけ使え、H.265 と QSV は開けない。AMF・VideoToolbox は入っていない */
function fakeFfmpeg(calls: string[][]): FfmpegRunner {
  return async (args) => {
    calls.push(args)
    const enc = args[args.indexOf('-c:v') + 1]
    if (args.includes('-version'))
      return {
        code: 0,
        stdout:
          'ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) 2000-2023\nbuilt with gcc',
        stderr: '',
        ms: 5
      }
    if (args.includes('-encoders')) return { code: 0, stdout: ENCODERS_OUT, stderr: '', ms: 5 }
    const speedTest = args.some((a) => a.startsWith('testsrc2='))
    if (enc === 'h264_nvenc') return { code: 0, stdout: '', stderr: '', ms: speedTest ? 1000 : 50 }
    if (enc === 'libx264') return { code: 0, stdout: '', stderr: '', ms: speedTest ? 5000 : 50 }
    if (enc === 'hevc_nvenc')
      return {
        code: 1,
        stdout: '',
        stderr:
          '[hevc_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2): (no details)\nError while opening encoder\nConversion failed!',
        ms: 50
      }
    return { code: 1, stdout: '', stderr: 'Error creating a MFX session: -9.', ms: 50 }
  }
}

describe('環境チェック: ハードウェアのエンコーダの判定(ffmpeg を差し替えて)', () => {
  it('一覧に載っていても、試し書き出しが通ったものだけを「使える」とする', async () => {
    const calls: string[][] = []
    const r = await checkEncoders(fakeFfmpeg(calls))
    expect(r.version).toBe('ffmpeg version 6.1.1-full_build-www.gyan.dev')
    const by = Object.fromEntries(r.encoders.map((e) => [e.encoder, e]))
    expect(by.h264_nvenc).toEqual({ encoder: 'h264_nvenc', listed: true, usable: true })
    expect(by.hevc_nvenc.usable).toBe(false)
    expect(by.hevc_nvenc.error).toContain('OpenEncodeSessionEx failed')
    expect(by.h264_qsv.error).toBe('Error creating a MFX session: -9.')
    expect(by.h264_amf).toEqual({ encoder: 'h264_amf', listed: false, usable: false })
    expect(by.h264_videotoolbox.listed).toBe(false)
    // 入っていないものは試さない
    expect(calls.some((a) => a.includes('h264_amf'))).toBe(false)
  })

  it('速さは 10 秒の試し映像の書き出しにかかった時間から(再生の何倍か)', async () => {
    const run = fakeFfmpeg([])
    expect(await measureSpeed(run, 'libx264')).toEqual({ encoder: 'libx264', seconds: 5, speed: 2 })
    expect(await measureSpeed(run, 'h264_nvenc')).toEqual({
      encoder: 'h264_nvenc',
      seconds: 1,
      speed: 10
    })
    const bad = await measureSpeed(run, 'h264_qsv')
    expect(bad.speed).toBeNull()
    expect(bad.error).toContain('MFX')
  })

  it('試し書き出し・速さの引数は書き出しと同じ作り(CPU は x264 veryfast、NVENC は p5)', () => {
    expect(trialArgs('h264_amf')).toEqual(
      expect.arrayContaining(['-c:v', 'h264_amf', '-f', 'null'])
    )
    expect(speedArgs('libx264')).toEqual(expect.arrayContaining(['-preset', 'veryfast']))
    expect(speedArgs('h264_nvenc')).toEqual(expect.arrayContaining(['-preset', 'p5']))
    expect(speedArgs('libx264').join(' ')).toContain('testsrc2=s=1920x1080:r=30:d=10')
  })

  it('ffmpeg -encoders の一覧を読む・エラーの意味のある最後の行を取る', () => {
    const names = parseEncoderList(ENCODERS_OUT)
    expect([...names]).toEqual(['libx264', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'aac'])
    expect(lastErrorLine('a\nreal reason\nConversion failed!\n')).toBe('real reason')
  })

  it.skipIf(process.platform === 'win32')(
    '本物の実行ファイルとして差し替えても同じに判定する(spawn の経路)',
    async () => {
      const script = join(tmp, 'fake-ffmpeg.cjs')
      writeFileSync(
        script,
        [
          'const a = process.argv.slice(2)',
          "const enc = a[a.indexOf('-c:v') + 1]",
          "if (a.includes('-version')) { console.log('ffmpeg version 9.9 Copyright x'); process.exit(0) }",
          `if (a.includes('-encoders')) { console.log(${JSON.stringify(ENCODERS_OUT)}); process.exit(0) }`,
          "if (enc === 'h264_nvenc' || enc === 'libx264') process.exit(0)",
          "process.stderr.write('No device available for encoder\\n'); process.exit(1)"
        ].join('\n')
      )
      const exe = join(tmp, 'ffmpeg')
      writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
      chmodSync(exe, 0o755)
      const r = await checkEncoders(spawnFfmpeg(exe))
      expect(r.version).toBe('ffmpeg version 9.9')
      expect(r.encoders.filter((e) => e.usable).map((e) => e.encoder)).toEqual(['h264_nvenc'])
      expect(r.encoders.find((e) => e.encoder === 'h264_qsv')?.error).toBe(
        'No device available for encoder'
      )
    }
  )

  it('ffmpeg が見つからない・止めたときは、終了コード null で理由を返す(例外にしない)', async () => {
    const missing = await spawnFfmpeg(join(tmp, 'no-such-ffmpeg'))(['-version'])
    expect(missing.code).toBeNull()
    const ac = new AbortController()
    const pending = spawnFfmpeg(process.execPath)(['-e', 'setTimeout(() => {}, 20000)'], ac.signal)
    ac.abort()
    const stopped = await pending
    expect(stopped.code).toBeNull()
    expect(stopped.stderr).toContain('止めました')
  })
})

describe('環境チェック: ローカル AI の構成の判定(モデルはダウンロードしない)', () => {
  const base = { unifiedMemory: false, gpuNames: [], ramGb: 32, appVersion: '1.0.0', failures: [] }
  it('GPU なし → CPU 用の 1.5B(理由つき)', () => {
    const r = judgeLocalAi({ ...base, gpu: false, vramGb: 0 })
    expect(r.device).toBe('cpu')
    expect(r.model).toBe('Qwen2.5 1.5B')
    expect(r.loadable).toBe(true)
    expect(r.note).toContain('GPU が無い')
  })
  it('CUDA の VRAM で 7B・14B を選ぶ', () => {
    expect(judgeLocalAi({ ...base, gpu: 'cuda', vramGb: 8 }).model).toBe('Qwen2.5 7B')
    expect(judgeLocalAi({ ...base, gpu: 'cuda', vramGb: 24 }).model).toBe('Qwen2.5 14B')
  })
  it('前に読み込めなかったモデルは軽いモデルに下げる(自動編集と同じ選び方)', () => {
    const env = { appVersion: '1.0.0', gpu: 'cuda', vramGb: 8, ramGb: 32 }
    const r = judgeLocalAi({
      ...base,
      gpu: 'cuda',
      vramGb: 8,
      failures: [
        { uri: 'hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M', label: 'Qwen2.5 7B', at: '', env }
      ]
    })
    expect(r.model).toBe('Qwen2.5 1.5B')
    expect(r.note).toContain('前回 Qwen2.5 7B を読み込めなかった')
  })
  it('メモリが明らかに足りなければ「使わない」と理由を出す', () => {
    const r = judgeLocalAi({ ...base, gpu: false, vramGb: 0, ramGb: 1 })
    expect(r.loadable).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})

describe('環境チェック: GPU の名前と VRAM', () => {
  it('getGPUInfo の deviceString・GL のレンダラ・VRAM の項目から', () => {
    const gpus = gpuDevicesFromInfo({
      gpuDevice: [
        {
          vendorId: 0x10de,
          deviceId: 0x2684,
          active: true,
          driverVersion: '31.0.15.5222',
          deviceString: 'NVIDIA GeForce RTX 4090'
        },
        { vendorId: 0x8086, deviceId: 0xa780, active: false }
      ],
      auxAttributes: {
        glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11)',
        videoMemory: 24564
      }
    })
    expect(gpus[0]).toEqual({
      name: 'NVIDIA GeForce RTX 4090',
      vendor: 'NVIDIA',
      vramMb: 24564,
      driver: '31.0.15.5222',
      active: true
    })
    expect(gpus[1].vendor).toBe('Intel')
    expect(gpus[1].vramMb).toBeUndefined()
    expect(gpuDevicesFromInfo(null)).toEqual([])
    // GPU を使わない描画(vendor・device が 0)は、そうと分かる名前に
    expect(gpuDevicesFromInfo({ gpuDevice: [{ vendorId: 0, deviceId: 0 }] })[0].name).toBe(
      'GPU を使っていない描画(ソフトウェア)'
    )
    // 1 つだけなら GL のレンダラを名前に
    expect(
      gpuDevicesFromInfo({
        gpuDevice: [{ vendorId: 0x1002 }],
        auxAttributes: { glRenderer: 'AMD Radeon' }
      })[0].name
    ).toBe('AMD Radeon')
  })
})

describe('環境チェック: 結果の組み立てと伏せ字', () => {
  const home = '/home/alice'
  const run = async (): Promise<{
    result: Awaited<ReturnType<typeof runEnvCheck>>
    progress: EnvCheckProgress[]
  }> => {
    const progress: EnvCheckProgress[] = []
    let t = Date.parse('2026-10-23T00:00:00Z')
    const result = await runEnvCheck({
      run: fakeFfmpeg([]),
      app: { product: 'Tsunagi', version: '1.0.0', electron: '39.2.6', chrome: '142' },
      gpuInfo: async () => ({
        gpuDevice: [{ vendorId: 0x10de, active: true, deviceString: 'NVIDIA GeForce RTX 4070' }],
        auxAttributes: { videoMemory: 12282 }
      }),
      gpuFeatures: () => ({ gpu_compositing: 'enabled' }),
      localAi: async () =>
        judgeLocalAi({
          gpu: 'cuda',
          vramGb: 12,
          unifiedMemory: false,
          gpuNames: ['NVIDIA GeForce RTX 4070'],
          ramGb: 32,
          appVersion: '1.0.0',
          failures: []
        }),
      whisper: async () => ({
        order: ['dml', 'cpu'],
        backends: ['cpu', 'dml'],
        model: 'onnx-community/whisper-large-v3-turbo_timestamped',
        downloaded: false,
        // 秘密と利用者名が紛れ込んでも伏せる
        error: `GEMINI_API_KEY=AIzaSyA1234567890abcdefghij at ${home}/AppData/models`
      }),
      system: () => ({
        os: 'Windows_NT 10.0.22631 (x64)',
        cpu: 'AMD Ryzen 7 7700',
        cores: 16,
        memoryGb: 32,
        freeMemoryGb: 20.5
      }),
      home,
      now: () => new Date((t += 1000)),
      onProgress: (p) => progress.push(p)
    })
    return { result, progress }
  }

  it('PC・GPU・エンコーダ・速さ・ローカル AI・文字起こしを 1 つにまとめる', async () => {
    const { result, progress } = await run()
    expect(result.gpus[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4070', vramMb: 12282 })
    // 速さは CPU と、使えたハードウェアだけ
    expect(result.speed.map((s) => s.encoder)).toEqual(['libx264', 'h264_nvenc'])
    expect(fastestEncoder(result.speed)).toEqual({ encoder: 'h264_nvenc', speed: 10, vsCpu: 5 })
    expect(result.localAi).toMatchObject({
      ok: true,
      device: 'cuda',
      model: 'Qwen2.5 7B',
      loadable: true
    })
    expect(progress.length).toBeGreaterThan(5)
    expect(progress[progress.length - 1]).toMatchObject({ step: '終わりました' })
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('秘密(API キー)とパスの中の利用者名は、画面に返す結果でも保存するテキストでも伏せる', async () => {
    const { result } = await run()
    const json = JSON.stringify(result)
    expect(json).not.toContain('AIzaSyA1234567890')
    expect(json).not.toContain('alice')
    expect(result.whisper.error).toContain('~/AppData/models')
    const text = buildEnvCheckReport(result)
    expect(text).not.toContain('AIzaSy')
    expect(text).not.toContain('alice')
  })

  it('保存するテキストに各欄と、自動では送らない旨が入る', async () => {
    const { result } = await run()
    const text = buildEnvCheckReport(result)
    for (const s of [
      '[PC]',
      '[GPU]',
      '[ハードウェアのエンコーダ]',
      '[ローカル AI(node-llama-cpp)]',
      '[文字起こし(Whisper)]'
    ])
      expect(text).toContain(s)
    expect(text).toContain('NVIDIA NVENC(H.264): 使える')
    expect(text).toContain('Apple VideoToolbox(H.264): この ffmpeg に入っていない')
    expect(text).toContain('一番速いもの: NVIDIA NVENC(H.264)(CPU の 5.0 倍)')
    expect(text).toContain('選ばれるモデル: Qwen2.5 7B')
    expect(text).toContain('DirectML(GPU) → CPU')
    expect(text).toContain('自動では送られません')
    expect(envCheckSections(result).map((s) => s.title)[0]).toBe('PC')
    expect(envCheckFileName('Tsunagi', new Date(2026, 9, 23, 9, 5))).toBe(
      'Tsunagi-環境チェック-20261023-0905.txt'
    )
  })

  it('Windows のパス(\\ 区切り)の利用者名と、入れ子の値も伏せる', () => {
    const r = redactResult(
      { a: ['C:\\Users\\alice\\x', { token: 'Bearer abcdefghijklmnop' }], n: 3 },
      'C:\\Users\\alice'
    )
    expect(JSON.stringify(r)).not.toContain('alice')
    expect(JSON.stringify(r)).not.toContain('abcdefghijklmnop')
    expect(r.n).toBe(3)
  })

  it('ヘルプのメニューに「環境チェック…」がある', () => {
    const help = buildMenuTemplate({}, [], { isDev: false, isMac: false }).find(
      (m) => m.label === 'ヘルプ(&H)'
    )
    expect(
      help?.submenu?.some((i) => i.id === 'help.envCheck' && i.label === '環境チェック…')
    ).toBe(true)
  })
})

describe('環境チェック: 止める・断る・GPU の情報の上限(監査の低)', () => {
  type Deps = Parameters<typeof runEnvCheck>[0]
  const baseDeps = (over: Partial<Deps> = {}): Deps => ({
    run: fakeFfmpeg([]),
    app: { product: 'Tsunagi', version: '1.0.0', electron: '39', chrome: '142' },
    gpuInfo: async () => ({ gpuDevice: [{ vendorId: 0x10de, active: true, deviceString: 'RTX' }] }),
    gpuFeatures: () => ({}),
    localAi: vi.fn(async () => ({ ok: true, device: 'cpu' })),
    whisper: vi.fn(async () => ({
      order: ['cpu'],
      backends: ['cpu'],
      model: 'm',
      downloaded: false
    })),
    system: () => ({ os: 'x', cpu: 'c', cores: 1, memoryGb: 1, freeMemoryGb: 1 }),
    ...over
  })

  it('止めた後は、ローカル AI・文字起こしの判定(別プロセスを立ち上げるもの)を呼ばない', async () => {
    const ac = new AbortController()
    const deps = baseDeps({
      signal: ac.signal,
      onProgress: (p) => {
        if (p.step.startsWith('書き出しの速さ')) ac.abort()
      }
    })
    const r = await runEnvCheck(deps)
    expect(deps.localAi).not.toHaveBeenCalled()
    expect(deps.whisper).not.toHaveBeenCalled()
    expect(r.localAi.error).toBe('止めました')
    expect(r.whisper.error).toBe('止めました')
  })

  it('書き出し中なら始めずに理由を付けて断る(ffmpeg も動かさない)', async () => {
    const calls: string[][] = []
    await expect(
      runEnvCheck(
        baseDeps({
          run: fakeFfmpeg(calls),
          busyReason: () => '書き出し中は環境チェックをできません'
        })
      )
    ).rejects.toBeInstanceOf(EnvCheckBusyError)
    expect(calls).toEqual([])
    expect(
      envCheckErrorMessage(
        new Error(
          "Error invoking remote method 'diag:envCheckRun': EnvCheckBusyError: 書き出し中は…"
        )
      )
    ).toBe('書き出し中は…')
  })

  it('GPU の詳しい情報が返らなければ上限で打ち切り、基本の情報で続ける', async () => {
    const never = (): Promise<unknown> => new Promise(() => {})
    const r = await runEnvCheck(
      baseDeps({
        gpuInfo: never,
        gpuInfoBasic: async () => ({ gpuDevice: [{ vendorId: 0x8086, active: true }] }),
        gpuInfoTimeoutMs: 30
      })
    )
    expect(r.gpus[0].vendor).toBe('Intel')
  })

  it('基本の情報も返らなければ「取得できませんでした」で続ける', async () => {
    const never = (): Promise<unknown> => new Promise(() => {})
    const r = await runEnvCheck(
      baseDeps({ gpuInfo: never, gpuInfoBasic: never, gpuInfoTimeoutMs: 30 })
    )
    expect(r.gpus).toEqual([])
    expect(buildEnvCheckReport(r)).toContain('GPU: 取得できませんでした')
    expect(r.speed.length).toBeGreaterThan(0)
  })

  it('GPU の情報を待っている間に「止める」と、上限を待たずに抜ける', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 20)
    const r = await runEnvCheck(
      baseDeps({
        gpuInfo: () => new Promise(() => {}),
        gpuInfoTimeoutMs: 60_000,
        signal: ac.signal
      })
    )
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.gpus).toEqual([])
  })

  it('withTimeout: 間に合えば値、過ぎれば代わりの値', async () => {
    expect(await withTimeout(Promise.resolve(1), 1000, 0)).toEqual({ value: 1, timedOut: false })
    expect(await withTimeout(new Promise<number>(() => {}), 10, 0)).toEqual({
      value: 0,
      timedOut: true
    })
  })
})

describe('環境チェック: onnxruntime の装置は「この PC で使える見込み」と「組み込み」に分ける', () => {
  it('GPU が無ければ CUDA・TensorRT は見込みに入れない', () => {
    expect(
      asrBackendView(['cpu', 'webgpu', 'cuda', 'tensorrt'], { platform: 'linux', hasNvidia: false })
    ).toEqual({ likely: ['cpu'], unverified: ['webgpu', 'cuda', 'tensorrt'] })
  })
  it('Windows は DirectML、NVIDIA があれば CUDA も見込み。macOS は Core ML', () => {
    expect(
      asrBackendView(['cpu', 'dml', 'cuda'], { platform: 'win32', hasNvidia: true }).likely
    ).toEqual(['cpu', 'dml', 'cuda'])
    expect(
      asrBackendView(['cpu', 'coreml', 'cuda'], { platform: 'darwin', hasNvidia: true })
    ).toEqual({ likely: ['cpu', 'coreml'], unverified: ['cuda'] })
  })
})
