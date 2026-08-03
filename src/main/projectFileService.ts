import { readFileSync, writeFileSync } from 'fs'
import type { Project } from '@shared/types'

export function saveProjectFile(filePath: string, project: Project): void {
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8')
}

export function loadProjectFile(filePath: string): Project {
  const raw = readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as Project
}
