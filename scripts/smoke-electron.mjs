/* eslint-disable @typescript-eslint/explicit-function-return-type -- 型は smoke-electron.d.mts */
// 作ったアプリを本当に起動して確かめる(煙の試験)。CI(.github/workflows/windows-release-gates.yml の package と
// release.yml)が、electron-builder の作った win-unpacked の VideoEditor.exe に対して走らせる。
// 配布物を小さくする変更(electron-builder.cjs の files)で、起動・ffmpeg・ffprobe・onnxruntime・node-llama-cpp が
// 壊れていないことを確かめるのが目的。
//
// 使い方:
//   node scripts/smoke-electron.mjs --exe dist/win-unpacked/VideoEditor.exe --build personal --out smoke
//   node scripts/smoke-electron.mjs --dev --out smoke   (手元: electron-vite build の後、out/ を node_modules の Electron で)
//
//   --exe <path>     起動する実行ファイル(electron-builder の出力)
//   --dev            node_modules の Electron でこのリポジトリ(out/)を起動する(--exe の代わり)
//   --build <kind>   --exe のとき、どの版か(release・personal)。release は resources/app-update.yml が GitHub の
//                    Releases を指すこと、personal は app-update.yml が無いことを確かめる
//   --out <dir>      画面の写真(main-window.png)・環境チェックの結果(env-check.json)・記録(smoke.log)の置き場
//   --skip-env-check 環境チェック(試し書き出しで 1〜2 分かかる)を飛ばす
//
// 確かめること(どれかが駄目なら終了コード 1):
// 1. 最初の窓が出て、上の帯の「書き出す」ボタンが描かれる。ページのエラー(pageerror)が無い・画面のプロセスが落ちない
// 2. 製品に入れた部品がある(ffmpeg・ffprobe・onnxruntime の DLL・ライセンスの表記・自動更新の行き先)
// 3. 環境チェック(ヘルプ > 環境チェック と同じ main の処理): ffmpeg が動いて CPU で書き出せる・onnxruntime を読める
//    (Windows は DirectML も)・node-llama-cpp を読める
// 4. 同梱の ffmpeg で作った短い動画を、アプリの probeMedia(同梱の ffprobe)で読める
//
// Playwright(playwright-core)はブラウザを落とさない。Electron の起動にだけ使う。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 製品に入っているはずの部品(resources からの相対パス) */
export function expectedPackagedFiles(platform, arch) {
  const unpacked = 'app.asar.unpacked/node_modules'
  const exe = platform === 'win32' ? '.exe' : ''
  const ort = `${unpacked}/onnxruntime-node/bin/napi-v6/${platform}/${arch}`
  const files = [
    'app.asar',
    'app.asar.unpacked/resources/THIRD_PARTY_NOTICES.txt',
    `${unpacked}/ffmpeg-static/ffmpeg${exe}`,
    `${unpacked}/@derhuerst/ffprobe-static/ffprobe${exe}`,
    `${ort}/onnxruntime_binding.node`
  ]
  // Windows の文字起こしは DirectML(GPU)を先に試す(asrDeviceOrder)。その DLL を外していないか
  if (platform === 'win32')
    files.push(
      `${ort}/onnxruntime.dll`,
      `${ort}/DirectML.dll`,
      `${ort}/dxcompiler.dll`,
      `${ort}/dxil.dll`
    )
  return files
}

/** 自動更新の行き先(resources/app-update.yml)の問題点。text は無ければ null */
export function updateConfigProblems(build, text) {
  if (build === 'personal')
    return text === null
      ? []
      : ['持ち主が試す版(personal)に自動更新の行き先(app-update.yml)が入っています']
  if (build !== 'release') return []
  if (text === null) return ['正式版に自動更新の行き先(resources/app-update.yml)がありません']
  const problems = []
  if (!/^provider:\s*github\s*$/m.test(text))
    problems.push(`app-update.yml が GitHub の Releases を指していません:\n${text}`)
  if (!/^owner:\s*rymaruta\s*$/m.test(text) || !/^repo:\s*VideoEditor\s*$/m.test(text))
    problems.push(`app-update.yml のリポジトリが rymaruta/VideoEditor ではありません:\n${text}`)
  if (/example\.(com|org|net|invalid)/i.test(text))
    problems.push(`app-update.yml に例の URL が残っています:\n${text}`)
  return problems
}

/** 環境チェックの結果(EnvCheckResult)の問題点 */
export function envCheckProblems(result, platform) {
  const problems = []
  if (!result || typeof result !== 'object') return ['環境チェックの結果がありません']
  if (!result.ffmpeg?.version) problems.push('ffmpeg を動かせません(版を読めません)')
  const cpu = (result.speed ?? []).find((s) => s.encoder === 'libx264')
  if (!cpu || cpu.seconds === null || cpu.seconds === undefined)
    problems.push(
      `ffmpeg で CPU(x264)の試し書き出しができません: ${cpu?.error ?? '結果がありません'}`
    )
  const w = result.whisper ?? {}
  if (w.error) problems.push(`onnxruntime を読み込めません: ${w.error}`)
  const backends = Array.isArray(w.backends) ? w.backends : []
  if (!backends.includes('cpu'))
    problems.push(`onnxruntime の CPU の装置がありません(装置: ${backends.join(', ') || 'なし'})`)
  if (platform === 'win32' && !backends.includes('dml'))
    problems.push(
      `onnxruntime の DirectML の装置がありません(装置: ${backends.join(', ') || 'なし'})`
    )
  if (!result.localAi?.ok)
    problems.push(`node-llama-cpp を読み込めません: ${result.localAi?.error ?? '(理由なし)'}`)
  return problems
}

/** probeMedia の結果(MediaProbeResult)の問題点。作った動画は 1 秒・映像と音声あり */
export function probeProblems(probe) {
  if (!probe || typeof probe !== 'object') return ['probeMedia の結果がありません']
  const problems = []
  if (!probe.hasVideo) problems.push('ffprobe で映像を読めません')
  if (!probe.hasAudio) problems.push('ffprobe で音声を読めません')
  if (!(Math.abs(Number(probe.duration) - 1) < 0.2))
    problems.push(`ffprobe の尺が違います: ${probe.duration}(1 秒のはず)`)
  return problems
}

function parseArgs(argv) {
  const opts = { dev: false, skipEnvCheck: false, out: 'smoke' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') opts.exe = argv[++i]
    else if (a === '--dev') opts.dev = true
    else if (a === '--build') opts.build = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--skip-env-check') opts.skipEnvCheck = true
    else throw new Error(`知らないオプション: ${a}`)
  }
  if (!opts.dev && !opts.exe) throw new Error('--exe <path> か --dev を指定してください')
  if (opts.build && !['release', 'personal'].includes(opts.build))
    throw new Error(`--build は release か personal: ${opts.build}`)
  return opts
}

/** 決まった時間で諦める */
function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}が ${ms / 1000} 秒で終わりませんでした`)),
        ms
      )
    })
  ]).finally(() => clearTimeout(timer))
}

async function main(argv, projectDir) {
  const opts = parseArgs(argv)
  const out = resolve(opts.out)
  mkdirSync(out, { recursive: true })
  const lines = []
  const log = (s) => {
    console.log(s)
    lines.push(s)
  }
  const problems = []
  const fail = (list) => {
    for (const p of list) log(`NG: ${p}`)
    problems.push(...list)
  }

  // 2. 製品の部品(--exe のとき)
  let ffmpegExe
  if (opts.exe) {
    const exe = resolve(opts.exe)
    if (!existsSync(exe)) throw new Error(`実行ファイルがありません: ${exe}`)
    const res = join(dirname(exe), 'resources')
    const missing = expectedPackagedFiles(process.platform, process.arch).filter(
      (f) => !existsSync(join(res, f))
    )
    fail(missing.map((f) => `製品に入っていません: resources/${f}`))
    if (missing.length === 0) log('OK: 製品の部品(ffmpeg・ffprobe・onnxruntime・表記)')
    const updatePath = join(res, 'app-update.yml')
    const updateText = existsSync(updatePath) ? readFileSync(updatePath, 'utf-8') : null
    const up = updateConfigProblems(opts.build, updateText)
    fail(up)
    if (opts.build && up.length === 0) log(`OK: 自動更新の行き先(${opts.build})`)
    ffmpegExe = join(
      res,
      'app.asar.unpacked/node_modules/ffmpeg-static',
      `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`
    )
  } else {
    ffmpegExe = join(
      projectDir,
      'node_modules/ffmpeg-static',
      `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`
    )
  }

  // 4 のための短い動画(同梱の ffmpeg で作る)
  const work = mkdtempSync(join(tmpdir(), 've-smoke-'))
  const clip = join(work, 'smoke-clip.mp4')
  const made = existsSync(ffmpegExe)
    ? spawnSync(
        ffmpegExe,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x240:rate=30:duration=1',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          '-y',
          clip
        ],
        { encoding: 'utf-8', timeout: 60_000 }
      )
    : null
  if (!made || made.status !== 0)
    fail([`同梱の ffmpeg で試しの動画を作れません: ${made?.stderr || made?.error || ffmpegExe}`])

  // 1. 起動
  const { _electron } = await import('playwright-core')
  const env = { ...process.env, VE_DISABLE_AUTO_UPDATE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  // Linux の root(開発用のコンテナ)では Chromium のサンドボックスが立ち上がらない
  const noSandbox = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []
  const launch = opts.exe
    ? { executablePath: resolve(opts.exe), args: noSandbox }
    : { executablePath: (await import('electron')).default, args: [projectDir, ...noSandbox] }
  log(`起動: ${launch.executablePath} ${launch.args.join(' ')}`)
  const started = Date.now()
  const app = await _electron.launch({ ...launch, env, timeout: 120_000 })
  const stderr = []
  app.process().stderr?.on('data', (d) => stderr.push(String(d)))
  app.process().stdout?.on('data', (d) => stderr.push(String(d)))
  const pageErrors = []
  const consoleErrors = []
  let page
  try {
    page = await app.firstWindow({ timeout: 120_000 })
    page.on('pageerror', (e) => pageErrors.push(e?.stack || String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('crash', () => pageErrors.push('画面のプロセスが落ちました'))
    await page.waitForLoadState('domcontentloaded')
    const exportButton = page.getByRole('button', { name: '書き出す', exact: true })
    await exportButton.first().waitFor({ state: 'visible', timeout: 90_000 })
    log(
      `OK: 最初の窓に「書き出す」ボタンが出ました(${((Date.now() - started) / 1000).toFixed(1)} 秒)`
    )
    const title = await page.title()
    log(`窓の題名: ${title}`)
    // 起動直後の非同期の処理(自動保存の確認・ライブラリの読み込み)のエラーも拾う
    await page.waitForTimeout(3000)
    await page.screenshot({ path: join(out, 'main-window.png') })
    log(`画面の写真: ${join(out, 'main-window.png')}`)

    // 3. 環境チェック
    if (!opts.skipEnvCheck) {
      log('環境チェックを走らせます(試し書き出しで 1〜2 分)')
      const result = await withTimeout(
        page.evaluate(() => window.api.envCheckRun()),
        6 * 60_000,
        '環境チェック'
      )
      writeFileSync(join(out, 'env-check.json'), JSON.stringify(result, null, 2))
      const env = envCheckProblems(result, process.platform)
      fail(env)
      log(
        `環境チェック: ffmpeg ${result?.ffmpeg?.version ?? '?'} / onnxruntime の装置 ${(result?.whisper?.backends ?? []).join(', ') || 'なし'} / ローカル AI ${result?.localAi?.ok ? (result.localAi.device ?? 'ok') : 'NG'}`
      )
      if (env.length === 0) log('OK: 環境チェック(ffmpeg・onnxruntime・node-llama-cpp)')
    }

    // 4. ffprobe(アプリの probeMedia)
    if (existsSync(clip)) {
      const probe = await withTimeout(
        page.evaluate((p) => window.api.probeMedia(p), clip),
        60_000,
        'probeMedia'
      )
      const pp = probeProblems(probe)
      fail(pp)
      if (pp.length === 0) log(`OK: ffprobe(probeMedia): ${JSON.stringify(probe)}`)
    }

    if (pageErrors.length > 0) fail(pageErrors.map((e) => `ページのエラー: ${e}`))
    else log('OK: ページのエラーはありません')
    if (consoleErrors.length > 0)
      log(
        `(参考)画面の console のエラー ${consoleErrors.length} 件:\n  ${consoleErrors.join('\n  ')}`
      )
  } catch (e) {
    fail([`起動の試験に失敗しました: ${e instanceof Error ? e.stack || e.message : String(e)}`])
    if (page && !page.isClosed())
      await page.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined)
  } finally {
    await withTimeout(app.close(), 30_000, 'アプリの終了').catch(() => {
      log('終了しなかったので止めます')
      app.process().kill()
    })
    rmSync(work, { recursive: true, force: true })
    writeFileSync(join(out, 'app-output.log'), stderr.join(''))
    writeFileSync(join(out, 'smoke.log'), lines.join('\n') + '\n')
  }
  if (problems.length > 0) {
    console.error(`\n起動の試験: ${problems.length} 件の問題(記録: ${out})`)
    return 1
  }
  console.log(`\n起動の試験: すべて OK(記録: ${out})`)
  return 0
}

const isDirectRun = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main(process.argv.slice(2), resolve(dirname(fileURLToPath(import.meta.url)), '..')).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  )
}
