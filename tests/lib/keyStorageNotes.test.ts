import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  keyStorageNotes,
  type KeyStorageNoteState
} from '../../src/renderer/src/lib/keyStorageNotes'
import { KeyStorageNote } from '../../src/renderer/src/components/KeyStorageNote'

// 画面の設定の状態(サーバー側の描画では zustand の setState が映らないので、選ぶ関数ごと差し替える)
const settings = vi.hoisted(() => ({
  state: {
    keyStorage: 'encrypted',
    keyStorageNote: '',
    unreadableKeys: [] as string[],
    unreadableCause: null,
    secretsFileNote: '',
    secretsFileProblemNote: ''
  } as Record<string, unknown>
}))
vi.mock('../../src/renderer/src/store/settingsStore', () => ({
  useSettingsStore: (select: (s: Record<string, unknown>) => unknown) => select(settings.state)
}))

/**
 * 鍵の欄の知らせは、どの欄にも出す。鍵の欄は投稿準備・トレンド・音源のタブに常に置かれていて
 * (見えないタブは隠すだけ)、「最初の欄にだけ出す」と見えている欄に出ないことがあった。
 */
const base: KeyStorageNoteState = {
  keyStorage: 'encrypted',
  keyStorageNote: '',
  unreadableKeys: [],
  unreadableCause: null,
  secretsFileNote: '',
  secretsFileProblemNote: ''
}

describe('鍵の欄の知らせ', () => {
  it('保存ファイル・暗号化できない PC の知らせは、どの欄にも同じく出す', () => {
    const state = {
      ...base,
      keyStorage: 'plain' as const,
      secretsFileNote: '保存ファイルが壊れていた',
      secretsFileProblemNote: '新しい版のもの'
    }
    for (const names of [['geminiApiKey'], ['youtubeApiKey'], ['jamendoClientId']] as const) {
      const notes = keyStorageNotes(state, names)
      expect(notes[0]).toBe('保存ファイルが壊れていた')
      expect(notes[1]).toBe('新しい版のもの')
      expect(notes[2]).toContain('暗号化はされません')
    }
  })

  it('読めなかった鍵の知らせは、その鍵の欄だけ', () => {
    const state = {
      ...base,
      unreadableKeys: ['geminiApiKey' as const],
      unreadableCause: 'decrypt' as const
    }
    expect(keyStorageNotes(state, ['geminiApiKey'])[0]).toContain('Gemini API キー')
    expect(keyStorageNotes(state, ['youtubeApiKey'])).toEqual([])
  })

  it('何も無ければ出さない', () => {
    expect(keyStorageNotes(base, ['geminiApiKey'])).toEqual([])
  })

  it('画面に同時に置かれた4つの欄(投稿準備・トレンド2つ・音源)のどれにも出る', () => {
    settings.state.secretsFileNote =
      'API キーの保存ファイルが壊れていたため、secrets.json.broken に退避しました。'
    const panels = [
      ['geminiApiKey'],
      ['youtubeApiKey'],
      ['youtubeApiKey', 'geminiApiKey'],
      ['freesoundApiKey']
    ] as const
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        ...panels.map((names, i) => createElement(KeyStorageNote, { key: i, names }))
      )
    )
    expect(html.match(/secrets\.json\.broken に退避しました/g)).toHaveLength(4)
  })
})
