import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeLoadedProject, useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'
import {
  editorActionFor,
  formatKeyDisplay,
  getEditorKeymap,
  getKeymap,
  matchesBinding,
  SHORTCUT_ACTIONS,
  type EditorBinding,
  type KeyLike,
  type KeymapScheme
} from '@renderer/lib/keymap'
import {
  goToEditPoint,
  goToMark,
  goToMarker,
  mainEditPoints,
  markIn,
  markOut,
  nextEditPoint,
  previousEditPoint,
  removeMarkerAtPlayhead,
  rippleDelete,
  rippleDeleteRange,
  rippleTrimToPlayhead,
  addMarkerAtPlayhead
} from '@renderer/lib/editCommands'
import {
  currentShuttleRate,
  isShuttling,
  nextShuttleRate,
  playRange,
  pressShuttleKey,
  releaseShuttleK,
  SHUTTLE_TICK_MS,
  stopRangePlayback,
  stopShuttle
} from '@renderer/lib/shuttle'
import { runEditorAction, type EditorKeyEnv } from '@renderer/lib/editorKeyActions'
import { useTimelineSubSelection } from '@renderer/lib/timelineSelection'
import { shortcutHelpSections, useShortcutHelpStore } from '@renderer/lib/shortcutHelp'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

const asset = (id: string, duration: number): Project['assets'][number] => ({
  id,
  filePath: `/x/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration,
  width: 1280,
  height: 720,
  fps: 30,
  hasAudio: true,
  hasVideo: true
})

/** 本編 4秒 + 4秒 + 4秒(c2 は分離音声つき)と、c3 に紐づくテロップ */
function baseProject(): Project {
  return {
    id: 'p',
    name: 'keys',
    aspectRatio: '16:9',
    assets: [asset('A', 20), asset('B', 20)],
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 },
      { id: 'c2', assetId: 'B', inPoint: 2, outPoint: 6, speed: 1, audioDetached: true },
      { id: 'c3', assetId: 'A', inPoint: 10, outPoint: 14, speed: 1 }
    ],
    audioTracks: [
      {
        id: 't1',
        name: '分離音声',
        volume: 1,
        muted: false,
        duckingEnabled: false,
        clips: [
          {
            id: 'a2',
            assetId: 'B',
            startTime: 4,
            inPoint: 2,
            outPoint: 6,
            volume: 1,
            speed: 1,
            linkedClipId: 'c2'
          }
        ]
      }
    ],
    videoOverlayTracks: [],
    textOverlays: []
  }
}

function reset(): void {
  useTimelineSubSelection.getState().setSubSelection(null, null)
  stopShuttle()
  stopRangePlayback()
  releaseShuttleK()
  S.setState({
    project: baseProject(),
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    playheadTime: 0,
    isPlaying: false,
    timelineIn: null,
    timelineOut: null
  })
}

const total = (): number =>
  st().project.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1), 0)

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : k === ' ' ? 'Space' : k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

beforeEach(reset)
afterEach(() => {
  stopShuttle()
  stopRangePlayback()
  vi.useRealTimers()
})

describe('キーの割り当て', () => {
  const schemes: KeymapScheme[] = ['default', 'premiere', 'capcut']

  /** 1つの割り当てが受け付ける押し方(Ctrl・Shift・Alt・キー)の一覧 */
  function signatures(b: EditorBinding): string[] {
    const shifts = b.shift === 'any' ? [false, true] : [Boolean(b.shift)]
    return b.keys.flatMap((k) =>
      shifts.map((s) => `${b.ctrl ? 'C' : ''}${s ? 'S' : ''}${b.alt ? 'A' : ''}+${k.toLowerCase()}`)
    )
  }

  for (const scheme of schemes) {
    it(`${scheme}: 既存のキー・道具のキー・矢印と、足したキーがぶつからない`, () => {
      const seen = new Map<string, string>()
      const add = (sig: string, owner: string): void => {
        const prev = seen.get(sig)
        // 同じ操作の別の書き方(Delete と Backspace など)は重なってよい
        if (prev && prev !== owner) throw new Error(`${sig}: ${prev} と ${owner} がぶつかる`)
        seen.set(sig, owner)
      }
      const basic = getKeymap(scheme)
      for (const a of SHORTCUT_ACTIONS) {
        const k = basic[a]
        const keys = k.key === 'Delete' ? ['delete', 'backspace'] : [k.key.toLowerCase()]
        for (const kk of keys) add(`${k.ctrl ? 'C' : ''}${k.shift ? 'S' : ''}+${kk}`, a)
      }
      add('C+y', 'redo')
      for (const t of ['a', 't', 'b']) add(`+${t}`, `tool:${t}`)
      for (const arrow of ['arrowleft', 'arrowright']) {
        add(`+${arrow}`, 'step')
        add(`S+${arrow}`, 'step10')
      }
      const editor = getEditorKeymap(scheme)
      for (const [action, bindings] of Object.entries(editor)) {
        for (const b of bindings) for (const sig of signatures(b)) add(sig, action)
      }
    })

    it(`${scheme}: どの足したキーも、既存のキーの判定には当たらない(既存の割り当ては変えていない)`, () => {
      const basic = getKeymap(scheme)
      const editor = getEditorKeymap(scheme)
      for (const bindings of Object.values(editor)) {
        for (const b of bindings) {
          for (const k of b.keys) {
            const e = key(k, {
              ctrlKey: Boolean(b.ctrl),
              shiftKey: b.shift === true,
              altKey: Boolean(b.alt)
            }) as KeyboardEvent
            for (const a of SHORTCUT_ACTIONS) {
              // Alt+Backspace は、Alt を見ない既存の Delete にも当たる。足した方を先に見るので届かない
              if (a === 'delete' && b.alt) continue
              expect(matchesBinding(e, basic[a]), `${b.display} が ${a} に当たる`).toBe(false)
            }
          }
        }
      }
    })
  }

  it('Premiere の既定どおりに読める', () => {
    const km = getEditorKeymap('premiere')
    expect(editorActionFor(key('j'), km)).toBe('shuttleReverse')
    expect(editorActionFor(key('K'), km)).toBe('shuttleStop')
    expect(editorActionFor(key('l'), km)).toBe('shuttleForward')
    expect(editorActionFor(key('i'), km)).toBe('markIn')
    expect(editorActionFor(key('I', { shiftKey: true }), km)).toBe('goToIn')
    expect(editorActionFor(key('o'), km)).toBe('markOut')
    expect(editorActionFor(key('x', { altKey: true }), km)).toBe('clearInOut')
    // macOS の Option+X は「≈」になる。キーの位置で読む
    expect(editorActionFor(key('≈', { altKey: true, code: 'KeyX' }), km)).toBe('clearInOut')
    expect(editorActionFor(key('Delete', { shiftKey: true }), km)).toBe('rippleDelete')
    expect(editorActionFor(key('Backspace', { altKey: true }), km)).toBe('rippleDelete')
    expect(editorActionFor(key('q'), km)).toBe('rippleTrimPrev')
    expect(editorActionFor(key('w'), km)).toBe('rippleTrimNext')
    expect(editorActionFor(key('ArrowUp'), km)).toBe('prevEditPoint')
    expect(editorActionFor(key('ArrowDown'), km)).toBe('nextEditPoint')
    expect(editorActionFor(key('Home'), km)).toBe('goToStart')
    expect(editorActionFor(key('End'), km)).toBe('goToEnd')
    expect(editorActionFor(key('='), km)).toBe('zoomIn')
    expect(editorActionFor(key('+', { shiftKey: true }), km)).toBe('zoomIn')
    expect(editorActionFor(key('-'), km)).toBe('zoomOut')
    expect(editorActionFor(key('\\'), km)).toBe('zoomFit')
    expect(editorActionFor(key('m'), km)).toBe('addMarker')
    expect(editorActionFor(key('M', { shiftKey: true }), km)).toBe('nextMarker')
    expect(editorActionFor(key('?', { shiftKey: true }), km)).toBe('shortcutHelp')
    expect(editorActionFor(key('/', { ctrlKey: true }), km)).toBe('shortcutHelp')
    // macOS は Cmd(metaKey)が Ctrl の代わり
    expect(editorActionFor(key('/', { metaKey: true }), km)).toBe('shortcutHelp')
    expect(editorActionFor(key(' ', { metaKey: true, shiftKey: true }), km)).toBe('playInToOut')
  })

  it('修飾キーが違えば当たらない(Ctrl+O は開く、Ctrl+I は読み込みのまま)', () => {
    const km = getEditorKeymap('premiere')
    expect(editorActionFor(key('o', { ctrlKey: true }), km)).toBeNull()
    expect(editorActionFor(key('i', { ctrlKey: true }), km)).toBeNull()
    expect(editorActionFor(key('m', { ctrlKey: true }), km)).toBeNull()
    expect(editorActionFor(key('Delete'), km)).toBeNull()
    expect(editorActionFor(key(' '), km)).toBeNull()
    expect(editorActionFor(key('ArrowLeft'), km)).toBeNull()
  })

  it('CapCut 風は拡大・縮小が Ctrl+= / Ctrl+-、全体表示が Shift+Z', () => {
    const km = getEditorKeymap('capcut')
    expect(editorActionFor(key('=', { ctrlKey: true }), km)).toBe('zoomIn')
    expect(editorActionFor(key('-', { ctrlKey: true }), km)).toBe('zoomOut')
    expect(editorActionFor(key('Z', { shiftKey: true }), km)).toBe('zoomFit')
    expect(editorActionFor(key('='), km)).toBeNull()
  })

  it('macOS の表記は ⌘ ⌥ ⇧', () => {
    expect(formatKeyDisplay('Ctrl+Shift+M', true)).toBe('⌘⇧M')
    expect(formatKeyDisplay('Ctrl+Alt+M', true)).toBe('⌘⌥M')
    expect(formatKeyDisplay('Shift+Delete', true)).toBe('⇧⌫')
    expect(formatKeyDisplay('Ctrl+=', true)).toBe('⌘=')
    expect(formatKeyDisplay('+', true)).toBe('+')
    expect(formatKeyDisplay('Ctrl+Shift+M', false)).toBe('Ctrl+Shift+M')
  })

  it('一覧は今の配置のキーを出す(Windows は Ctrl、macOS は ⌘)', () => {
    const win = shortcutHelpSections('premiere', false)
    const mac = shortcutHelpSections('premiere', true)
    const find = (sections: typeof win, label: string): string[] =>
      sections.flatMap((s) => s.rows).find((r) => r.label === label)?.keys ?? []
    expect(find(win, '分割')).toContain('Ctrl+K')
    expect(find(mac, '分割')).toContain('⌘K')
    expect(find(win, 'リップル削除(後ろを詰める)')).toEqual(['Shift+Delete', 'Alt+Backspace'])
    expect(find(shortcutHelpSections('capcut', false), 'タイムライン全体を表示')).toEqual([
      'Shift+Z'
    ])
    expect(find(shortcutHelpSections('default', false), '分割')).toContain('S')
  })
})

describe('イン・アウト', () => {
  it('I / O で打ち、Alt+X で消す。企画を切り替えたら捨てる', () => {
    S.setState({ playheadTime: 2 })
    markIn()
    S.setState({ playheadTime: 7 })
    markOut()
    expect([st().timelineIn, st().timelineOut]).toEqual([2, 7])
    st().clearTimelineInOut()
    expect([st().timelineIn, st().timelineOut]).toEqual([null, null])
    markIn()
    st().newProject()
    expect(st().timelineIn).toBeNull()
  })

  it('アウトより後ろにインを打つと、アウトを捨てる(逆も同じ)', () => {
    st().setTimelineOut(3)
    st().setTimelineIn(5)
    expect([st().timelineIn, st().timelineOut]).toEqual([5, null])
    st().setTimelineOut(4)
    expect([st().timelineIn, st().timelineOut]).toEqual([null, 4])
  })

  it('イン・アウトは履歴にも企画にも入らない', () => {
    markIn()
    expect(st().past).toHaveLength(0)
    expect(st().isDirty).toBe(false)
  })

  it('Shift+I / Shift+O でイン・アウトへ移る(打っていなければ動かない)', () => {
    expect(goToMark('in')).toBe(false)
    st().setTimelineIn(3)
    st().setTimelineOut(9)
    expect(goToMark('out')).toBe(true)
    expect(st().playheadTime).toBe(9)
    expect(goToMark('in')).toBe(true)
    expect(st().playheadTime).toBe(3)
  })

  it('イン〜アウトの再生はアウトで止まる', () => {
    st().setTimelineIn(1)
    st().setTimelineOut(3)
    expect(playRange(1, 3)).toBe(true)
    expect(st().isPlaying).toBe(true)
    expect(st().playheadTime).toBe(1)
    st().setPlayheadTime(2)
    expect(st().isPlaying).toBe(true)
    st().setPlayheadTime(3.02)
    expect(st().isPlaying).toBe(false)
    expect(st().playheadTime).toBe(3)
    // 見張りは外れている(また再生してもアウトで止めない)
    st().setIsPlaying(true)
    st().setPlayheadTime(5)
    expect(st().isPlaying).toBe(true)
  })
})

describe('リップル削除・リップルトリム', () => {
  it('Q: 再生位置より前を切って詰め、再生位置を切った所へ移す。1回の取り消しで戻る', () => {
    const before = st().project
    S.setState({ playheadTime: 5 }) // c2 の 1秒目
    expect(rippleTrimToPlayhead('start')).toBe(true)
    const c2 = st().project.clips.find((c) => c.id === 'c2')!
    expect([c2.inPoint, c2.outPoint]).toEqual([3, 6])
    expect(total()).toBeCloseTo(11)
    expect(st().playheadTime).toBe(4)
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().project.clips).toEqual(before.clips)
    expect(st().project.audioTracks).toEqual(before.audioTracks)
  })

  it('W: 再生位置より後ろを切って詰める(再生位置は動かない)', () => {
    S.setState({ playheadTime: 9 }) // c3 の 1秒目
    expect(rippleTrimToPlayhead('end')).toBe(true)
    const c3 = st().project.clips.find((c) => c.id === 'c3')!
    expect([c3.inPoint, c3.outPoint]).toEqual([10, 11])
    expect(st().playheadTime).toBe(9)
    expect(total()).toBeCloseTo(9)
  })

  it('W を境目で押すと、次のクリップを丸ごと消して詰める。Q を境目で押しても何もしない', () => {
    S.setState({ playheadTime: 4 })
    expect(rippleTrimToPlayhead('start')).toBe(false)
    expect(st().past).toHaveLength(0)
    expect(rippleTrimToPlayhead('end')).toBe(true)
    expect(st().project.clips.map((c) => c.id)).toEqual(['c1', 'c3'])
    // 紐づいた分離音声も一緒に消える(Delete と同じ)
    expect(st().project.audioTracks[0].clips).toHaveLength(0)
    st().undo()
    expect(st().project.clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(st().project.audioTracks[0].clips).toHaveLength(1)
  })

  it('Q / W を続けて押しても、取り消しは1回ずつ戻る(まとめない)', () => {
    S.setState({ playheadTime: 1 })
    rippleTrimToPlayhead('end') // c1 を 0..1 に
    S.setState({ playheadTime: 0.5 })
    rippleTrimToPlayhead('end') // c1 を 0..0.5 に
    expect(st().past).toHaveLength(2)
    st().undo()
    expect(st().project.clips[0].outPoint).toBe(1)
  })

  it('末尾(クリップの外)では何もしない', () => {
    S.setState({ playheadTime: 12 })
    expect(rippleTrimToPlayhead('start')).toBe(false)
    expect(rippleTrimToPlayhead('end')).toBe(false)
  })

  it('イン〜アウトのリップル削除: 範囲が抜けて詰まり、1回の取り消しで丸ごと戻る', () => {
    const before = st().project
    expect(rippleDeleteRange(2, 9)).toBe(true)
    expect(total()).toBeCloseTo(5)
    expect(st().past).toHaveLength(1)
    // 残りは c1 の前半(0..2)と c3 の後半(11..14)
    const clips = st().project.clips
    expect(clips.map((c) => [c.assetId, c.inPoint, c.outPoint])).toEqual([
      ['A', 0, 2],
      ['A', 11, 14]
    ])
    st().undo()
    expect(st().project.clips).toEqual(before.clips)
    expect(st().project.audioTracks).toEqual(before.audioTracks)
    st().redo()
    expect(total()).toBeCloseTo(5)
  })

  it('Shift+Delete: 選んだクリップを消して詰める(1件の履歴)', () => {
    S.setState({ selectedClipId: 'c2', multiSelectedClipIds: ['c2'] })
    expect(rippleDelete()).toBe(true)
    expect(st().project.clips.map((c) => c.id)).toEqual(['c1', 'c3'])
    expect(st().past).toHaveLength(1)
  })

  it('Shift+Delete: 選んでいなければイン〜アウトを抜き、範囲を消して再生位置をインへ', () => {
    expect(rippleDelete()).toBe(false)
    st().setTimelineIn(1)
    st().setTimelineOut(3)
    S.setState({ playheadTime: 10 })
    expect(rippleDelete()).toBe(true)
    expect(total()).toBeCloseTo(10)
    expect([st().timelineIn, st().timelineOut]).toEqual([null, null])
    expect(st().playheadTime).toBe(1)
    expect(st().past).toHaveLength(1)
  })

  it('消すものが無い範囲(短すぎる)では、分割も残さない', () => {
    expect(rippleDeleteRange(5, 5.00001)).toBe(false)
    expect(st().past).toHaveLength(0)
    expect(st().project.clips).toHaveLength(3)
  })
})

describe('編集点・先頭・末尾', () => {
  it('編集点は先頭・境目・末尾', () => {
    expect(mainEditPoints(st().project)).toEqual([0, 4, 8, 12])
    expect(previousEditPoint([0, 4, 8], 4)).toBe(0)
    expect(nextEditPoint([0, 4, 8], 4)).toBe(8)
    expect(nextEditPoint([0, 4, 8], 8)).toBeNull()
  })

  it('↑ / ↓ で前・次の編集点へ', () => {
    S.setState({ playheadTime: 5 })
    goToEditPoint(1)
    expect(st().playheadTime).toBe(8)
    goToEditPoint(1)
    expect(st().playheadTime).toBe(12)
    expect(goToEditPoint(1)).toBe(false)
    goToEditPoint(-1)
    goToEditPoint(-1)
    expect(st().playheadTime).toBe(4)
  })

  it('Home / End', () => {
    S.setState({ playheadTime: 5 })
    runEditorAction('goToEnd', { repeat: false }, () => false)
    expect(st().playheadTime).toBe(12)
    runEditorAction('goToStart', { repeat: false }, () => false)
    expect(st().playheadTime).toBe(0)
  })
})

describe('マーカー', () => {
  it('M で打ち、同じフレームでは増えない。取り消しで消える', () => {
    S.setState({ playheadTime: 3 })
    const id = addMarkerAtPlayhead()
    expect(st().project.markers).toEqual([{ id, time: 3 }])
    S.setState({ playheadTime: 3.01 })
    expect(addMarkerAtPlayhead()).toBe(id)
    expect(st().project.markers).toHaveLength(1)
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().project.markers).toBeUndefined()
  })

  it('Shift+M / Ctrl+Shift+M で次・前へ、Ctrl+Alt+M で消す', () => {
    for (const t of [6, 2, 9]) {
      S.setState({ playheadTime: t })
      addMarkerAtPlayhead()
    }
    expect(st().project.markers!.map((m) => m.time)).toEqual([2, 6, 9])
    S.setState({ playheadTime: 0 })
    goToMarker(1)
    expect(st().playheadTime).toBe(2)
    goToMarker(1)
    expect(st().playheadTime).toBe(6)
    goToMarker(-1)
    expect(st().playheadTime).toBe(2)
    expect(removeMarkerAtPlayhead()).toBe(true)
    expect(st().project.markers!.map((m) => m.time)).toEqual([6, 9])
    S.setState({ playheadTime: 4 })
    expect(removeMarkerAtPlayhead()).toBe(false)
    st().undo()
    expect(st().project.markers!.map((m) => m.time)).toEqual([2, 6, 9])
  })

  it('保存したマーカーを開き直せる(壊れた要素は捨て、時刻順に並べる)', () => {
    const raw = {
      ...baseProject(),
      markers: [
        { id: 'm2', time: 8, label: '見せ場', color: 'green' },
        { id: 'm1', time: 1 },
        { time: 'x' },
        { id: 'm1', time: 3 },
        null
      ]
    } as unknown as Project
    const loaded = normalizeLoadedProject(raw)
    expect(loaded.markers!.map((m) => m.time)).toEqual([1, 3, 8])
    expect(new Set(loaded.markers!.map((m) => m.id)).size).toBe(3)
    // 知らない項目も残す(新しい版の項目を古い版で消さない)
    expect((loaded.markers![2] as unknown as Record<string, unknown>).color).toBe('green')
    expect(normalizeLoadedProject(baseProject()).markers).toBeUndefined()
  })
})

describe('J / K / L のシャトル', () => {
  it('押すたびの速さ', () => {
    expect(nextShuttleRate(0, 'l')).toBe(1)
    expect(nextShuttleRate(1, 'l')).toBe(2)
    expect(nextShuttleRate(2, 'l')).toBe(4)
    expect(nextShuttleRate(4, 'l')).toBe(4)
    expect(nextShuttleRate(0, 'j')).toBe(-1)
    expect(nextShuttleRate(-1, 'j')).toBe(-2)
    expect(nextShuttleRate(2, 'j')).toBe(-1)
    expect(nextShuttleRate(-4, 'l')).toBe(1)
    expect(nextShuttleRate(4, 'k')).toBe(0)
  })

  it('L はふつうの再生、もう1回で 2倍(再生位置を送る)、K で止まる', () => {
    vi.useFakeTimers()
    S.setState({ playheadTime: 2 })
    pressShuttleKey('l')
    expect(st().isPlaying).toBe(true)
    expect(isShuttling()).toBe(false)
    pressShuttleKey('l')
    expect(st().isPlaying).toBe(false)
    expect(currentShuttleRate()).toBe(2)
    vi.advanceTimersByTime(SHUTTLE_TICK_MS * 15) // 約1秒
    expect(st().playheadTime).toBeGreaterThan(3.8)
    expect(st().playheadTime).toBeLessThan(4.2)
    pressShuttleKey('k')
    releaseShuttleK()
    expect(isShuttling()).toBe(false)
    const at = st().playheadTime
    vi.advanceTimersByTime(1000)
    expect(st().playheadTime).toBe(at)
  })

  it('J は戻る方向へ送り、先頭で止まる', () => {
    vi.useFakeTimers()
    S.setState({ playheadTime: 1 })
    pressShuttleKey('j')
    expect(currentShuttleRate()).toBe(-1)
    vi.advanceTimersByTime(SHUTTLE_TICK_MS * 8) // 約0.5秒
    expect(st().playheadTime).toBeGreaterThan(0.4)
    expect(st().playheadTime).toBeLessThan(0.6)
    pressShuttleKey('j') // 2倍
    vi.advanceTimersByTime(2000)
    expect(st().playheadTime).toBe(0)
    expect(isShuttling()).toBe(false)
  })

  it('送っている途中にふつうの再生が始まったら、送るのをやめる', () => {
    vi.useFakeTimers()
    S.setState({ playheadTime: 5 })
    pressShuttleKey('j')
    st().setIsPlaying(true)
    vi.advanceTimersByTime(SHUTTLE_TICK_MS * 2)
    expect(isShuttling()).toBe(false)
  })

  it('K を押したままの J / L は1フレームずつ(30fps)', () => {
    S.setState({ playheadTime: 1 })
    pressShuttleKey('k')
    pressShuttleKey('l')
    expect(st().playheadTime).toBeCloseTo(1 + 1 / 30)
    pressShuttleKey('j')
    pressShuttleKey('j')
    expect(st().playheadTime).toBeCloseTo(1 - 1 / 30)
    expect(isShuttling()).toBe(false)
    expect(st().isPlaying).toBe(false)
    releaseShuttleK()
    pressShuttleKey('l')
    expect(st().isPlaying).toBe(true)
  })

  it('ダイアログが開いたら送るのをやめる', () => {
    vi.useFakeTimers()
    let covered = false
    S.setState({ playheadTime: 5 })
    pressShuttleKey('j', { shouldStop: () => covered })
    covered = true
    vi.advanceTimersByTime(SHUTTLE_TICK_MS * 2)
    expect(isShuttling()).toBe(false)
  })
})

describe('キーの振り分け(runEditorAction)', () => {
  it('タイムラインが隠れている間は何もしない', () => {
    S.setState({ playheadTime: 5 })
    expect(runEditorAction('addMarker', { repeat: false }, () => true)).toBe(false)
    expect(st().project.markers).toBeUndefined()
  })

  it('押しっぱなしの繰り返しは、移動・拡大縮小のほかは1回とみなす', () => {
    S.setState({ playheadTime: 5 })
    runEditorAction('addMarker', { repeat: true }, () => false)
    expect(st().project.markers).toBeUndefined()
    runEditorAction('nextEditPoint', { repeat: true }, () => false)
    expect(st().playheadTime).toBe(8)
  })

  it('? で一覧を開け閉めする', () => {
    useShortcutHelpStore.getState().setOpen(false)
    runEditorAction('shortcutHelp', { repeat: false }, () => false)
    expect(useShortcutHelpStore.getState().open).toBe(true)
    runEditorAction('shortcutHelp', { repeat: false }, () => false)
    expect(useShortcutHelpStore.getState().open).toBe(false)
  })

  it('I / O / Q / M をキーから', () => {
    S.setState({ playheadTime: 5 })
    runEditorAction('markIn', { repeat: false }, () => false)
    runEditorAction('addMarker', { repeat: false }, () => false)
    runEditorAction('rippleTrimPrev', { repeat: false }, () => false)
    expect(st().timelineIn).toBe(5)
    expect(st().project.markers).toHaveLength(1)
    expect(total()).toBeCloseTo(11)
    expect(st().playheadTime).toBe(4)
  })
})

const env = (patch: Partial<EditorKeyEnv> = {}): EditorKeyEnv => ({
  sourceViewerVisible: () => false,
  popoverOpen: () => false,
  pageHidden: () => false,
  ...patch
})
const press = (action: Parameters<typeof runEditorAction>[0], e: EditorKeyEnv = env()): boolean =>
  runEditorAction(action, { repeat: false }, () => false, e)

describe('監査の指摘(二重操作・ソースのタブ・吹き出し・マーカーの範囲・シャトルの停止)', () => {
  it('音声・PiP を選んで I/O があるときの Shift+Delete は、イン〜アウトを抜かない(タイムライン側が消すだけ)', () => {
    const before = st().project
    st().setTimelineIn(2)
    st().setTimelineOut(4)
    for (const sub of [
      { audio: { trackId: 't1', clipId: 'a2' }, videoOverlay: null },
      { audio: null, videoOverlay: { trackId: 'v1', clipId: 'p1' } }
    ]) {
      useTimelineSubSelection.getState().setSubSelection(sub.audio, sub.videoOverlay)
      expect(rippleDelete()).toBe(false)
      expect(press('rippleDelete')).toBe(false)
      expect(st().project).toBe(before)
      expect(st().past).toHaveLength(0)
      expect([st().timelineIn, st().timelineOut]).toEqual([2, 4])
    }
    // 選びを外せば、イン〜アウトを抜く
    useTimelineSubSelection.getState().setSubSelection(null, null)
    expect(rippleDelete()).toBe(true)
    expect(st().past).toHaveLength(1)
  })

  it('テロップを選んでいるときも、イン〜アウトを抜かない', () => {
    st().setTimelineIn(2)
    st().setTimelineOut(4)
    S.setState({ selectedOverlayId: 'tx1' })
    expect(rippleDelete()).toBe(false)
    expect(st().past).toHaveLength(0)
  })

  it('ソースのタブが見えている間は、本編を変える・本編の再生位置を動かすキーを通さない', () => {
    const source = env({ sourceViewerVisible: () => true })
    S.setState({ playheadTime: 5 })
    st().setTimelineIn(1)
    st().setTimelineOut(3)
    const before = st().project
    for (const a of [
      'rippleTrimPrev',
      'rippleTrimNext',
      'rippleDelete',
      'addMarker',
      'nextMarker',
      'prevMarker',
      'removeMarker',
      'clearInOut',
      'goToIn',
      'goToOut',
      'playInToOut',
      'prevEditPoint',
      'nextEditPoint',
      'goToStart',
      'goToEnd',
      'shuttleReverse',
      'shuttleStop',
      'shuttleForward',
      'markIn',
      'markOut'
    ] as const) {
      expect(press(a, source), a).toBe(false)
    }
    expect(st().project).toBe(before)
    expect(st().past).toHaveLength(0)
    expect(st().playheadTime).toBe(5)
    expect(st().isPlaying).toBe(false)
    expect([st().timelineIn, st().timelineOut]).toEqual([1, 3])
    // 一覧は開ける
    useShortcutHelpStore.getState().setOpen(false)
    expect(press('shortcutHelp', source)).toBe(true)
    expect(useShortcutHelpStore.getState().open).toBe(true)
    useShortcutHelpStore.getState().setOpen(false)
  })

  it('吹き出し・右クリックのメニューが開いている間は Q・W・M・↑↓ を通さない', () => {
    const popover = env({ popoverOpen: () => true })
    S.setState({ playheadTime: 5 })
    for (const a of [
      'rippleTrimPrev',
      'rippleTrimNext',
      'addMarker',
      'prevEditPoint',
      'nextEditPoint'
    ] as const) {
      expect(press(a, popover), a).toBe(false)
    }
    expect(st().past).toHaveLength(0)
    expect(st().playheadTime).toBe(5)
    expect(st().project.markers).toBeUndefined()
  })

  it('マーカーの時刻は読み込みで 0〜本編の長さに収める(1e308 を受けない)', () => {
    const loaded = normalizeLoadedProject({
      ...baseProject(),
      markers: [
        { id: 'far', time: 1e308 },
        { id: 'n', time: 5 }
      ]
    } as unknown as Project)
    expect(loaded.markers!.map((m) => m.time)).toEqual([5, 12])
  })

  it('末尾より先にマーカーを打たない。本編を縮めても Shift+M は末尾より先へ飛ばない', () => {
    st().addMarker(99)
    expect(st().project.markers!.map((m) => m.time)).toEqual([12])
    S.setState({ playheadTime: 10 })
    // 本編を 8 秒に縮める(マーカーは 12 のまま)
    st().removeClips(['c3'])
    S.setState({ playheadTime: 7 })
    expect(goToMarker(1)).toBe(true)
    expect(st().playheadTime).toBe(8)
    expect(goToMarker(1)).toBe(false)
  })

  it('シャトルの送りは、窓が隠れたら止まる', () => {
    vi.useFakeTimers()
    reset()
    let hidden = false
    S.setState({ playheadTime: 5 })
    press('shuttleReverse', env({ pageHidden: () => hidden }))
    expect(isShuttling()).toBe(true)
    hidden = true
    vi.advanceTimersByTime(SHUTTLE_TICK_MS * 2)
    expect(isShuttling()).toBe(false)
  })

  it('テロップのタブでもシャトルの送りは止まらない(止める条件は窓が隠れた・タイムラインが覆われたときだけ)', async () => {
    // 監査: テロップのタブではタイムラインもプログラムも見えたままなのに、送りが止まり J・2倍・4倍が効かなかった
    const { readFileSync } = await import('fs')
    const src = readFileSync('src/renderer/src/lib/editorKeyActions.ts', 'utf-8')
    expect(src).not.toMatch(/telop-panel|telopTabOpen/)
    vi.useFakeTimers()
    reset()
    S.setState({ playheadTime: 5 })
    press('shuttleReverse', env({}))
    vi.advanceTimersByTime(SHUTTLE_TICK_MS * 3)
    expect(isShuttling()).toBe(true)
    expect(st().playheadTime).toBeLessThan(5)
  })
})
