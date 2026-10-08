/**
 * アプリのメニューバー(ファイル / 編集 / クリップ / …)。Windows の編集ソフトと同じ並び。
 *
 * ここは**メニューの形だけ**を決める純関数。main プロセスがこれを Electron のメニューにし、
 * 押された項目の `id` を画面へ送る。画面側(`menuCommands`)が既存の操作を呼ぶ。
 *
 * ショートカットの表示は、画面で選んでいるキー配置(Premiere 風 / CapCut 風)から作る。
 * **キーそのものは画面側の既存の処理が受ける**(メニューはキーを横取りしない)。
 * メニューでもキーを受けると、同じ操作が2回走るため。
 */

export type MenuCommand =
  | 'file.new'
  | 'file.newEpisode'
  | 'file.open'
  | 'file.restoreDiscarded'
  | `file.recent.${number}`
  | 'file.save'
  | 'file.saveAs'
  | 'file.importVideo'
  | 'file.importAudio'
  | 'file.addLibraryFolder'
  | 'file.export'
  | 'edit.undo'
  | 'edit.redo'
  | 'clip.split'
  | 'clip.delete'
  | 'clip.copy'
  | 'clip.paste'
  | 'clip.duplicate'
  | 'sequence.playPause'
  | 'telop.add'
  | 'telop.list'
  | 'telop.auto'
  | 'telop.styles'
  | 'auto.screen'
  | 'auto.allInOne'
  | 'auto.roughCut'
  | 'auto.longFormShort'
  | 'view.library'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomFit'
  | 'help.shortcuts'
  | 'help.about'
  | `window.${string}`

/** 画面から受け取る、ショートカットの表示(キー配置で変わるもの) */
export type MenuShortcuts = Partial<
  Record<
    'undo' | 'redo' | 'copy' | 'paste' | 'duplicate' | 'save' | 'playPause' | 'split' | 'delete',
    string
  >
>

export interface MenuItemSpec {
  label?: string
  id?: MenuCommand
  /** Electron の accelerator 形式(表示用) */
  accelerator?: string
  /**
   * キーをメニュー(OS)で受けるか。既定は受けない(画面のキー操作の設定で受ける操作は、画面で受ける)。
   * 画面のキー操作に無いファイルの操作(開く・書き出し など)は受ける。受けないと、メニューに
   * 書いてあるキーを押しても何も起きなかった
   */
  registerAccelerator?: boolean
  role?:
    | 'quit'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'selectAll'
    | 'togglefullscreen'
    | 'toggleDevTools'
    | 'reload'
  type?: 'separator'
  enabled?: boolean
  submenu?: MenuItemSpec[]
}

const SEP: MenuItemSpec = { type: 'separator' }

/**
 * 画面のキー表示(`Ctrl+Shift+Z` `Space` `S` など)を Electron の accelerator に直す。
 * 直せないものは undefined(メニューにキーを出さないだけ)。
 */
export function displayToAccelerator(display: string | undefined): string | undefined {
  if (!display) return undefined
  const parts = display
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return undefined
  const mapped = parts.map((p) => {
    const lower = p.toLowerCase()
    if (lower === 'ctrl' || lower === 'cmd' || lower === '⌘') return 'CmdOrCtrl'
    if (lower === 'shift' || lower === '⇧') return 'Shift'
    if (lower === 'alt' || lower === 'option') return 'Alt'
    if (lower === 'space' || lower === 'スペース') return 'Space'
    if (lower === 'delete' || lower === 'del') return 'Delete'
    if (lower === 'backspace') return 'Backspace'
    if (/^[a-z0-9]$/i.test(p)) return p.toUpperCase()
    if (/^f\d{1,2}$/i.test(p)) return p.toUpperCase()
    return null
  })
  return mapped.every((m) => m !== null) ? mapped.join('+') : undefined
}

/** ファイルの欄の、その時々で変わる中身 */
export interface MenuFileState {
  /** 最近使ったプロジェクト(新しい順。表示名) */
  recent: readonly string[]
  /** 起動時に破棄した自動保存データを戻せるか */
  canRestoreDiscarded: boolean
}

export function buildMenuTemplate(
  shortcuts: MenuShortcuts,
  windows: readonly { id: string; label: string }[],
  options: { isDev: boolean; isMac: boolean },
  fileState: MenuFileState = { recent: [], canRestoreDiscarded: false }
): MenuItemSpec[] {
  const key = (k: keyof MenuShortcuts): string | undefined => displayToAccelerator(shortcuts[k])
  const menu: MenuItemSpec[] = [
    {
      label: 'ファイル(&F)',
      submenu: [
        {
          label: '新規プロジェクト',
          id: 'file.new',
          accelerator: 'CmdOrCtrl+N',
          registerAccelerator: true
        },
        {
          label: '新しい回を作る…',
          id: 'file.newEpisode',
          accelerator: 'CmdOrCtrl+Shift+N',
          registerAccelerator: true
        },
        { label: '開く…', id: 'file.open', accelerator: 'CmdOrCtrl+O', registerAccelerator: true },
        {
          label: '最近使ったプロジェクト',
          submenu:
            fileState.recent.length > 0
              ? fileState.recent.map((label, i) => ({
                  label,
                  id: `file.recent.${i}` as MenuCommand
                }))
              : [{ label: '(なし)', enabled: false }]
        },
        {
          label: '破棄した自動保存データを戻す',
          id: 'file.restoreDiscarded',
          enabled: fileState.canRestoreDiscarded
        },
        SEP,
        { label: '保存', id: 'file.save', accelerator: key('save') },
        {
          label: '名前を付けて保存…',
          id: 'file.saveAs',
          accelerator: 'CmdOrCtrl+Shift+S',
          registerAccelerator: true
        },
        SEP,
        {
          label: '動画を読み込む…',
          id: 'file.importVideo',
          accelerator: 'CmdOrCtrl+I',
          registerAccelerator: true
        },
        { label: '音声を読み込む…', id: 'file.importAudio' },
        { label: 'フォルダをライブラリに追加…', id: 'file.addLibraryFolder' },
        SEP,
        {
          label: '書き出し…',
          id: 'file.export',
          accelerator: 'CmdOrCtrl+M',
          registerAccelerator: true
        },
        SEP,
        { label: '終了', role: 'quit' }
      ]
    },
    {
      label: '編集(&E)',
      submenu: [
        { label: '元に戻す', id: 'edit.undo', accelerator: key('undo') },
        { label: 'やり直す', id: 'edit.redo', accelerator: key('redo') },
        SEP,
        { label: '切り取り', role: 'cut' },
        { label: 'コピー', role: 'copy' },
        { label: '貼り付け', role: 'paste' },
        { label: 'すべて選択', role: 'selectAll' }
      ]
    },
    {
      label: 'クリップ(&C)',
      submenu: [
        { label: '再生位置で分割', id: 'clip.split', accelerator: key('split') },
        { label: '削除', id: 'clip.delete', accelerator: key('delete') },
        SEP,
        { label: 'クリップをコピー', id: 'clip.copy', accelerator: key('copy') },
        { label: 'クリップを貼り付け', id: 'clip.paste', accelerator: key('paste') },
        { label: '複製', id: 'clip.duplicate', accelerator: key('duplicate') }
      ]
    },
    {
      label: 'シーケンス(&S)',
      submenu: [
        { label: '再生 / 停止', id: 'sequence.playPause', accelerator: key('playPause') },
        SEP,
        { label: '書き出し…', id: 'file.export' }
      ]
    },
    {
      label: 'テロップ(&T)',
      submenu: [
        { label: 'テロップを追加', id: 'telop.add' },
        { label: '音声から自動でテロップを作る…', id: 'telop.auto' },
        SEP,
        { label: 'テロップの一覧', id: 'telop.list' },
        { label: 'テロップスタイルの管理…', id: 'telop.styles' }
      ]
    },
    {
      label: '自動編集(&A)',
      submenu: [
        { label: '自動編集の画面', id: 'auto.screen' },
        SEP,
        { label: 'AIおまかせ全自動編集…', id: 'auto.allInOne' },
        { label: '複数素材から自動ラフカット…', id: 'auto.roughCut' },
        { label: '長尺からショートを自動生成…', id: 'auto.longFormShort' }
      ]
    },
    {
      label: '表示(&V)',
      submenu: [
        { label: 'ライブラリ', id: 'view.library' },
        SEP,
        { label: 'タイムラインを拡大', id: 'view.zoomIn' },
        { label: 'タイムラインを縮小', id: 'view.zoomOut' },
        { label: 'タイムライン全体を表示', id: 'view.zoomFit' },
        SEP,
        { label: '全画面表示', role: 'togglefullscreen' },
        ...(options.isDev
          ? [
              SEP,
              { label: '再読み込み', role: 'reload' as const },
              { label: '開発者ツール', role: 'toggleDevTools' as const }
            ]
          : [])
      ]
    },
    {
      label: 'ウィンドウ(&W)',
      submenu: windows.map((w) => ({ label: w.label, id: `window.${w.id}` as MenuCommand }))
    },
    {
      label: 'ヘルプ(&H)',
      submenu: [
        { label: 'キーボードショートカット', id: 'help.shortcuts' },
        SEP,
        { label: 'バージョン情報', id: 'help.about' }
      ]
    }
  ]
  return options.isMac
    ? [{ label: 'VideoEditor', submenu: [{ label: '終了', role: 'quit' }] }, ...menu]
    : menu
}
