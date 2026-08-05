import { readFileSync, writeFileSync } from 'fs'
import type { Project } from '@shared/types'

export function saveProjectFile(filePath: string, project: Project): void {
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8')
}

export function loadProjectFile(filePath: string): Project {
  const raw = readFileSync(filePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      'プロジェクトファイルを読み込めませんでした。ファイルが壊れているか、対応していない形式です。'
    )
  }
  // Without this, a file that parses to null/an array/a number reaches the store
  // and blows up later with an opaque "Cannot read properties of null".
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('プロジェクトファイルの形式が正しくありません。')
  }
  return parsed as Project
}
