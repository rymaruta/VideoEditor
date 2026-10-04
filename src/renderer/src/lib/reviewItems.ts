import type { SyncIssue } from '@shared/sync/solve'
import { COLOR_VERDICT_TEXT } from '@shared/color/match'
import { AUTO_PLACE_CONFIDENCE } from '@shared/telop/effects'
import type { Project } from '@shared/types'
import type { QcReport } from '../store/qcStore'
import { placedUtterances } from './transcriptTimeline'
import { autoTelopKey } from '@shared/telop/manual'
import { stripTelopMarkup } from '@shared/telop/render'

/**
 * 要確認の一覧(計画書 §5.13)。自動編集の各工程が「自信の低い箇所」をここへ出し、人はここから直す。
 * - 同期: 音が合わなかった素材・位置の食い違い・同じ機材の重なり
 * - 話者: 声が重なった発言(話者と文字を確かめる)
 * - テロップ: 上下どちらでも顔に掛かる / 書き出し後の確認(はみ出し・短い表示・確認する言葉・表記)
 * - カメラの色: 合わせられなかったカメラ / ピンマイク: ノイズ除去ができなかったもの
 * - 演出テロップ: 自信が低く自動では置かなかった提案
 * 「このままでよい」にした項目はプロジェクトに保存する(`project.reviewed`)。
 */

export type ReviewArea = 'sync' | 'speaker' | 'telop' | 'color' | 'audio' | 'effects' | 'export'

export interface ReviewItem {
  key: string
  area: ReviewArea
  kind: string
  text: string
  /** タイムラインの秒(移れる項目だけ) */
  at?: number
  /** そのテロップを選んで移る */
  overlayId?: string
  /** 自動編集の画面の、どのタブで直すか */
  tab?: 'sync' | 'transcript' | 'effects'
}

export interface ReviewSources {
  project: Project
  syncIssues: readonly SyncIssue[]
  /** 同期の素材の名前(ファイルの ID → 表示名) */
  fileLabel: (fileId: string) => string
  /** その素材が今のタイムラインで映る時刻(秒)。本編に残っていなければ undefined */
  placedStart: (fileId: string) => number | undefined
  telopReviews: readonly { startTime: number; text: string; key?: string | null }[]
  colorIssues: readonly { name: string; verdict: keyof typeof COLOR_VERDICT_TEXT }[]
  denoiseFailures: readonly { fileName: string; error: string }[]
  effects: readonly { id: string; text: string; confidence: number }[]
  effectChosen: readonly string[]
  qc: QcReport | null
}

export function issueKey(issue: SyncIssue): string {
  switch (issue.kind) {
    case 'unsynced':
      return `unsynced:${issue.fileId}`
    case 'conflict':
      return `conflict:${issue.a}:${issue.b}`
    case 'overlap':
      return `overlap:${issue.a}:${issue.b}`
  }
}

function syncItem(issue: SyncIssue, s: ReviewSources): ReviewItem {
  const base = { key: issueKey(issue), area: 'sync' as const, tab: 'sync' as const }
  switch (issue.kind) {
    case 'unsynced':
      return {
        ...base,
        kind: '同期',
        text: `${s.fileLabel(issue.fileId)} は、ほかの素材と音が一致しませんでした(タイムラインには並べていません)`
      }
    case 'conflict':
      return {
        ...base,
        kind: '食い違い',
        text: `${s.fileLabel(issue.a)} と ${s.fileLabel(issue.b)} の位置が ${Math.abs(issue.difference * 1000).toFixed(0)}ms 食い違っています`,
        at: s.placedStart(issue.b)
      }
    case 'overlap':
      return {
        ...base,
        kind: '重なり',
        text: `${s.fileLabel(issue.a)} と ${s.fileLabel(issue.b)} が同じ機材で ${issue.overlap.toFixed(1)} 秒重なっています`,
        at: s.placedStart(issue.b)
      }
  }
}

export function buildReviewItems(s: ReviewSources): ReviewItem[] {
  const items: ReviewItem[] = s.syncIssues.map((i) => syncItem(i, s))

  for (const p of placedUtterances(s.project).filter((x) => x.utterance.overlap))
    items.push({
      key: `overlap-voice:${p.utterance.id}`,
      area: 'speaker',
      kind: '声の重なり',
      text: `${p.utterance.speaker ?? '話者不明'}「${p.utterance.text.slice(0, 40)}」— ほかの人と同時に話しています。話者と文字を確かめてください`,
      at: p.start,
      tab: 'transcript'
    })

  // 作り直し・文字の直し・前のクリップの削除でテロップの時刻や文字は変わるので、
  // 自動テロップの鍵(発話+何枚目)で探し、印もその鍵で付ける(時刻で付けると作り直しで印が消える)
  const dismissed = new Set(s.project.dismissedTelops ?? [])
  for (const r of s.telopReviews) {
    if (r.key && dismissed.has(r.key)) continue // 人が消したテロップ
    const overlay = r.key
      ? s.project.textOverlays.find((o) => autoTelopKey(o) === r.key)
      : s.project.textOverlays.find(
          (o) => Math.abs(o.startTime - r.startTime) < 1e-3 && o.text === r.text
        )
    // 一覧は1行の文で見せるので、`**強調**` などの印は外す
    const text = stripTelopMarkup(overlay?.text ?? r.text)
    items.push({
      key: `telop-face:${r.key ?? r.startTime.toFixed(2)}`,
      area: 'telop',
      kind: 'テロップと顔',
      text: `「${text.replace(/\n/g, ' ').slice(0, 30)}」— 上下どちらに置いても顔に掛かります。位置を確かめてください`,
      at: overlay?.startTime ?? r.startTime,
      overlayId: overlay?.id
    })
  }

  for (const c of s.colorIssues)
    items.push({
      key: `color:${c.name}`,
      area: 'color',
      kind: 'カメラの色',
      text: `${c.name} は${COLOR_VERDICT_TEXT[c.verdict]}。色味を目で確かめてください`
    })

  for (const d of s.denoiseFailures)
    items.push({
      key: `denoise:${d.fileName}`,
      area: 'audio',
      kind: 'ノイズ除去',
      text: `${d.fileName} はノイズ除去ができず、元の録音のままです${d.error ? `(${d.error})` : ''}`
    })

  const chosen = new Set(s.effectChosen)
  const pending = s.effects.filter((e) => !chosen.has(e.id) && e.confidence < AUTO_PLACE_CONFIDENCE)
  if (pending.length > 0)
    items.push({
      // 提案は1回の通しで1度しか作らないので、鍵は固定。中身(どれが残っているか)で鍵を変えると、
      // 1件選ぶたびに「確認済み」が外れて項目が出直す
      key: 'effects-pending',
      area: 'effects',
      kind: '演出テロップ',
      text: `自信が低く自動では置かなかった提案が ${pending.length} 件あります(「演出テロップ」タブで選べます)`,
      tab: 'effects'
    })

  if (s.qc && s.qc.state === 'done')
    for (const q of s.qc.issues)
      items.push({
        key: `qc:${q.kind}:${q.overlayId ?? ''}:${q.start.toFixed(2)}`,
        area: 'export',
        kind: '書き出しの確認',
        text: q.message,
        at: q.start,
        overlayId: q.overlayId
      })

  return items.sort(
    (a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY)
  )
}

/** 確認済みを除いた件数(画面の下のバーに出す) */
export function openReviewCount(items: readonly ReviewItem[], reviewed: readonly string[]): number {
  const done = new Set(reviewed)
  return items.filter((i) => !done.has(i.key)).length
}
