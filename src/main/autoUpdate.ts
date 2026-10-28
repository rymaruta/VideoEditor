/**
 * 自動更新(electron-updater)。正式版(GitHub の Releases から配るインストーラ)だけが、同じ Releases の
 * latest.yml を見て新しい版を探し、裏でダウンロードして、終了したときに入れ替える。
 *
 * どの版が更新を確かめるか(updateCheckPlan)
 * - 正式版(electron-builder.cjs が package.json に `videoEditorBuild: 'release'` を書いた物)・Windows・
 *   インストールした物(app.isPackaged)だけ
 * - 持ち主が試す版(VE_PERSONAL_BUILD=1 で作った物。`videoEditorBuild: 'personal'`)は確かめない
 *   (正式版で置き換えられないように。そもそも更新の行き先 app-update.yml も入れない)
 * - 開発中(npm run dev・印の無い package.json)・macOS・Linux は確かめない(Releases に置くのは Windows 版だけ)
 * - 環境変数 VE_DISABLE_AUTO_UPDATE=1 で止められる(起動の試験など)
 *
 * electron には依存しない(試験のため)。electron-updater・ダイアログは index.ts から渡す。
 */

/** electron-builder.cjs が、製品に入れる package.json に書く印のキー */
export const BUILD_KIND_KEY = 'videoEditorBuild'

export type BuildKind = 'release' | 'personal' | 'dev'

/** 製品に入った package.json から、どの版かを読む(印が無い・読めないときは開発中) */
export function readBuildKind(pkg: unknown): BuildKind {
  const v = (pkg as Record<string, unknown> | null | undefined)?.[BUILD_KIND_KEY]
  return v === 'release' || v === 'personal' ? v : 'dev'
}

export type UpdateCheckPlan = { check: true } | { check: false; reason: string }

/** 更新を確かめるか。確かめないときは理由(記録用) */
export function updateCheckPlan(input: {
  isPackaged: boolean
  platform: string
  buildKind: BuildKind
  env: Record<string, string | undefined>
}): UpdateCheckPlan {
  if (input.env.VE_DISABLE_AUTO_UPDATE === '1')
    return { check: false, reason: 'VE_DISABLE_AUTO_UPDATE=1 で止めています' }
  if (input.buildKind === 'personal')
    return { check: false, reason: '持ち主が試す版(personal)なので、更新を確かめません' }
  if (!input.isPackaged || input.buildKind !== 'release')
    return { check: false, reason: '開発中の版なので、更新を確かめません' }
  if (input.platform !== 'win32') return { check: false, reason: '自動更新は Windows 版だけです' }
  return { check: true }
}

/** 使う electron-updater の autoUpdater の一部(試験では偽物を渡す) */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface AutoUpdateDeps {
  /** electron-updater を読む(確かめる版でだけ読む) */
  loadUpdater: () => Promise<UpdaterLike>
  /** ダウンロードし終えた版を、今すぐ入れるか(再起動)・あとで(終了したとき)か尋ねる */
  ask: (version: string) => Promise<'restart' | 'later'>
  log: (message: string, error?: unknown) => void
  /**
   * いつもどおりの終了を始める(窓を閉じる)。保存していない変更・処理中の確かめはここで出て、
   * キャンセルされれば終了しない。終了まで進んだときだけ will-quit で onWillQuit が入れ替える
   */
  requestQuit: () => void
}

/** 起動してから最初に確かめるまで(起動の重い処理と取り合わない) */
export const FIRST_CHECK_DELAY_MS = 15_000
/** その後に確かめる間隔 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface AutoUpdateHandle {
  stop: () => void
  /**
   * will-quit で呼ぶ。「再起動して更新」を選んだあと終了まで進んだなら、入れ替えて起動し直す
   * (選ばなければ autoInstallOnAppQuit が、終了したときに起動し直さずに入れる)
   */
  onWillQuit: () => void
}

/**
 * 自動更新を始める。確かめない版なら何もしない(electron-updater も読まない)で null。
 * 確かめるのに失敗しても(ネットが無い・GitHub が答えない)記録するだけで、利用者には出さない。
 */
export function startAutoUpdate(
  plan: UpdateCheckPlan,
  deps: AutoUpdateDeps,
  options: { firstDelayMs?: number; intervalMs?: number } = {}
): AutoUpdateHandle | null {
  if (!plan.check) {
    deps.log(`自動更新: ${plan.reason}`)
    return null
  }
  let updater: UpdaterLike | null = null
  let stopped = false
  let checking = false
  /** 「再起動して更新」を選んだ(終了まで進んだら入れ替えて起動し直す) */
  let restartRequested = false
  /** 尋ねた版(同じ版で何度も尋ねない) */
  const asked = new Set<string>()

  const ready = (async (): Promise<UpdaterLike | null> => {
    try {
      const u = await deps.loadUpdater()
      // 裏でダウンロードし、終了したときに入れ替える(書き出しの途中で勝手に再起動しない)
      u.autoDownload = true
      u.autoInstallOnAppQuit = true
      u.on('error', (e) => deps.log('自動更新: 確かめられませんでした', e))
      u.on('update-downloaded', (info) => {
        const version = String(info?.version ?? '')
        if (stopped || asked.has(version)) return
        asked.add(version)
        deps
          .ask(version)
          .then((choice) => {
            // ここで quitAndInstall すると、終了の確かめ(保存していない変更・処理中)より先に
            // インストーラが動き、アプリを閉じてしまう。まずいつもどおり終了を始め、確かめを通って
            // 終了まで進んだときだけ(will-quit → onWillQuit)入れ替える
            if (choice === 'restart' && !stopped) {
              restartRequested = true
              deps.requestQuit()
            }
          })
          .catch((e) => deps.log('自動更新: 尋ねられませんでした', e))
      })
      updater = u
      return u
    } catch (e) {
      deps.log('自動更新: electron-updater を読めませんでした', e)
      return null
    }
  })()

  const check = async (): Promise<void> => {
    const u = updater ?? (await ready)
    if (!u || stopped || checking) return
    checking = true
    try {
      await u.checkForUpdates()
    } catch (e) {
      deps.log('自動更新: 確かめられませんでした', e)
    } finally {
      checking = false
    }
  }

  const first = setTimeout(() => void check(), options.firstDelayMs ?? FIRST_CHECK_DELAY_MS)
  const every = setInterval(() => void check(), options.intervalMs ?? CHECK_INTERVAL_MS)
  return {
    stop: () => {
      stopped = true
      clearTimeout(first)
      clearInterval(every)
    },
    onWillQuit: () => {
      if (!restartRequested || !updater) return
      restartRequested = false
      try {
        updater.quitAndInstall(false, true)
      } catch (e) {
        deps.log('自動更新: 入れ替えられませんでした', e)
      }
    }
  }
}
