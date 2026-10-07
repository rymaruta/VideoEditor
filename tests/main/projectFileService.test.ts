import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProjectFile, saveProjectFile } from '@main/projectFileService'
import type { Project } from '@shared/types'

/**
 * 企画ファイルの保存と読み込み。保存は「隣に書いて、ディスクに届くまで待ってから rename」なので、
 * 途中で失敗しても元のファイルは残り、一時ファイルも残らない。
 * 壊れた・途中で切れたファイルは、生の英語ではなく日本語の理由で止まる。
 */
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 've-projfile-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const project = (name: string): Project => ({
  id: 'p',
  name,
  aspectRatio: '16:9',
  assets: [],
  clips: [],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: []
})

describe('projectFileService', () => {
  it('保存して開くと同じ中身。上書きしても一時ファイルは残らない', () => {
    const path = join(dir, 'a.veproj')
    saveProjectFile(path, project('一回目'))
    saveProjectFile(path, project('二回目'))
    expect(loadProjectFile(path).name).toBe('二回目')
    expect(readdirSync(dir)).toEqual(['a.veproj'])
  })

  it('書いている途中で失敗しても、元のファイルはそのまま・一時ファイルも残らない', () => {
    const path = join(dir, 'a.veproj')
    saveProjectFile(path, project('元'))
    const before = readFileSync(path, 'utf-8')
    // JSON にできない値(循環)で、書く途中に失敗させる
    const broken = project('壊れ') as Project & { self?: unknown }
    broken.self = broken
    expect(() => saveProjectFile(path, broken)).toThrow('プロジェクトを保存できませんでした')
    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['a.veproj'])
  })

  it('途中で切れたファイル・中身が企画でないファイルは、日本語の理由で止まる', () => {
    const path = join(dir, 'cut.veproj')
    const full = JSON.stringify(project('長い企画'))
    writeFileSync(path, full.slice(0, Math.floor(full.length / 2)))
    expect(() => loadProjectFile(path)).toThrow('ファイルが壊れているか')
    writeFileSync(path, '[1,2,3]')
    expect(() => loadProjectFile(path)).toThrow('形式が正しくありません')
    writeFileSync(path, '')
    expect(() => loadProjectFile(path)).toThrow('ファイルが壊れているか')
  })
})

describe('手直しした企画ファイル', () => {
  it('頭に BOM が付いた(メモ帳で保存した)ファイルも開ける', () => {
    const path = join(dir, 'bom.veproj')
    writeFileSync(path, '﻿' + JSON.stringify(project('BOM付き')), 'utf-8')
    expect(loadProjectFile(path).name).toBe('BOM付き')
  })
})
