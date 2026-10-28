import { create } from 'zustand'
import type { MediaAsset } from '@shared/types'

/**
 * プログラムの見出しの「全体を表示 ▾」(表示の大きさ)と「画質 ▾」(プレビューの画質)。
 * どちらも画面だけの設定で、書き出しには効かない。
 *
 * - 大きさ: 全体を表示(枠に収める)か、企画の画の実寸(16:9 なら 1920×1080、9:16 なら 1080×1920)
 *   に対する倍率。収まらない分は送って見る
 * - 画質: 「最高」は元の素材(プレビューで読めない形式だけ、今までどおり軽い版)。
 *   「軽い」は全部の動画を 540p の軽い版(プロキシ)で再生する。軽い版は素材の読み込みで
 *   使っているのと同じ変換(`ensurePreviewProxy`、作った物は使い回す)で、無いものだけ作る
 */

export type ProgramZoom = 'fit' | 0.25 | 0.5 | 1
export type PreviewQuality = 'full' | 'light'

export const ZOOM_CHOICES: readonly { id: ProgramZoom; label: string }[] = [
  { id: 'fit', label: '全体を表示' },
  { id: 0.25, label: '25%' },
  { id: 0.5, label: '50%' },
  { id: 1, label: '100%' }
]

export const QUALITY_CHOICES: readonly { id: PreviewQuality; label: string; title: string }[] = [
  { id: 'full', label: '最高', title: '元の素材で再生します(プレビューで読めない形式だけ軽い版)' },
  {
    id: 'light',
    label: '軽い(540p)',
    title:
      '全部の動画を 540p の軽い版で再生します(重い素材でもコマが落ちにくい。書き出しは元の素材)'
  }
]

/** 企画の画の実寸の幅(100% のときの枠の幅、CSS の px) */
export function fullFrameWidth(aspectRatio: string): number {
  return aspectRatio === '9:16' ? 1080 : 1920
}

/** 大きさの倍率から枠の幅(px)。全体を表示なら null(枠に収める) */
export function zoomFrameWidth(zoom: ProgramZoom, aspectRatio: string): number | null {
  return zoom === 'fit' ? null : Math.round(fullFrameWidth(aspectRatio) * zoom)
}

/** 軽い版を作る相手: 動画を持つ素材(静止画・音声だけの素材と、もう軽い版があるものは除く) */
export function assetsNeedingLightProxy(
  assets: readonly MediaAsset[],
  made: Readonly<Record<string, string>>
): MediaAsset[] {
  const seen = new Set<string>()
  return assets.filter((a) => {
    if (a.still || !a.hasVideo || a.proxyPath || made[a.filePath] || seen.has(a.filePath))
      return false
    seen.add(a.filePath)
    return true
  })
}

const QUALITY_KEY = 've-preview-quality'

function readQuality(): PreviewQuality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'light' ? 'light' : 'full'
  } catch {
    return 'full'
  }
}

interface ProgramViewState {
  zoom: ProgramZoom
  quality: PreviewQuality
  /** 作った軽い版(元のファイルのパス → 軽い版のパス)。この PC のこの起動の間だけ */
  lightProxies: Record<string, string>
  /** 軽い版を作っている途中(作り終えた数 / 全部) */
  lightProgress: { done: number; total: number } | null
  lightError: string | null
  setZoom: (zoom: ProgramZoom) => void
  setQuality: (quality: PreviewQuality) => void
}

let runToken = 0

export const useProgramView = create<ProgramViewState>((set) => ({
  zoom: 'fit',
  quality: readQuality(),
  lightProxies: {},
  lightProgress: null,
  lightError: null,
  setZoom: (zoom) => set({ zoom }),
  setQuality: (quality) => {
    try {
      localStorage.setItem(QUALITY_KEY, quality)
    } catch {
      // 覚えられなくても今回は切り替わる
    }
    // 「最高」に戻したら、作っている途中の続きはやめる(作るのは「軽い」の間、見出しの部品が受け持つ)
    if (quality !== 'light') runToken++
    set({ quality, lightError: null, ...(quality !== 'light' ? { lightProgress: null } : {}) })
  }
}))

/**
 * 軽い版が無い動画の軽い版を 1 本ずつ作る(作り終えたものから軽い版で再生する)。
 * `getAssets` は今の企画の素材を返す: 作っている間に素材が増えた・企画が替わったら、
 * 終わったあとに残りも作る。「最高」に戻したら次の 1 本からは作らない
 * (main 側の変換には止める仕組みが無いので、作っている途中の 1 本は終わるまで走る。結果は使わない)
 */
export async function makeLightProxies(getAssets: () => readonly MediaAsset[]): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.ensurePreviewProxy) return
  const token = ++runToken
  const alive = (): boolean => token === runToken && useProgramView.getState().quality === 'light'
  let failed = 0
  let done = 0
  const tried = new Set<string>()
  for (;;) {
    if (!alive()) return
    const todo = assetsNeedingLightProxy(
      getAssets(),
      useProgramView.getState().lightProxies
    ).filter((a) => !tried.has(a.filePath))
    if (todo.length === 0) break
    const a = todo[0]
    tried.add(a.filePath)
    useProgramView.setState({ lightProgress: { done, total: done + todo.length } })
    try {
      const path = await window.api.ensurePreviewProxy(a.filePath, a.id)
      if (!alive()) return
      useProgramView.setState((s) => ({ lightProxies: { ...s.lightProxies, [a.filePath]: path } }))
    } catch {
      if (!alive()) return
      failed++
    }
    done++
  }
  useProgramView.setState({
    lightProgress: null,
    lightError:
      failed > 0 ? `${failed} 本の軽い版を作れませんでした(その素材は元のまま再生します)` : null
  })
}

/** プレビューが読むファイルの差し替え(画質「軽い」のときの軽い版)。無ければ undefined */
export function lightProxyFor(filePath: string): string | undefined {
  const st = useProgramView.getState()
  return st.quality === 'light' ? st.lightProxies[filePath] : undefined
}
