import { create } from 'zustand'

/** インスペクタのタブ(プロパティ / 色 / AI の判断)。選んだタブはこの PC に覚える */
export type InspectorTab = 'properties' | 'color' | 'decision'

export const INSPECTOR_TABS: readonly { id: InspectorTab; label: string; description: string }[] = [
  {
    id: 'properties',
    label: 'プロパティ',
    description: '選択したクリップの尺・速度・フレーミング・繋ぎ・音声をまとめて編集'
  },
  {
    id: 'color',
    label: '色',
    description: '選択したクリップの素材(カメラ)の色合わせ・色の調整'
  },
  {
    id: 'decision',
    label: 'AI の判断',
    description: '自動編集がこのクリップをなぜこうしたか(場面の判定・カメラ・手の判断)'
  }
]

const KEY = 've-inspector-tab'

function readTab(): InspectorTab {
  try {
    const v = localStorage.getItem(KEY)
    return INSPECTOR_TABS.some((t) => t.id === v) ? (v as InspectorTab) : 'properties'
  } catch {
    return 'properties'
  }
}

export const useInspectorTab = create<{
  tab: InspectorTab
  setTab: (tab: InspectorTab) => void
}>((set) => ({
  tab: readTab(),
  setTab: (tab) => {
    try {
      localStorage.setItem(KEY, tab)
    } catch {
      // 覚えられなくても今回は切り替わる
    }
    set({ tab })
  }
}))
