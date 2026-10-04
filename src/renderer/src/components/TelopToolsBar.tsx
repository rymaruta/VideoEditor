import { useMemo, useState } from 'react'
import { defaultTextStyle } from '@shared/textStyle'
import { buildSrt, parseSrt, telopMatches } from '@shared/telop/srt'
import { safeFileBaseName } from '@shared/fileName'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'

/**
 * テロップの一覧の上の道具: 検索と置換、字幕ファイル(SRT)の読み込み・書き出し。
 * Premiere の「キャプション」パネル・Vrew の一括置換と同じ使い方(誤変換の言葉を全部直す、
 * 他のソフトと字幕をやり取りする)。
 */
export function TelopToolsBar({ onSelect }: { onSelect: (id: string) => void }): React.JSX.Element {
  const overlays = useProjectStore((s) => s.project.textOverlays)
  const projectName = useProjectStore((s) => s.project.name)
  const replaceTelopText = useProjectStore((s) => s.replaceTelopText)
  const addTextOverlays = useProjectStore((s) => s.addTextOverlays)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [loose, setLoose] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  const matches = useMemo(
    () =>
      query
        ? [...overlays]
            .filter((o) => telopMatches(o.text, query, { loose }))
            .sort((a, b) => a.startTime - b.startTime)
        : [],
    [overlays, query, loose]
  )

  function findNext(): void {
    if (matches.length === 0) return
    const store = useProjectStore.getState()
    const now = store.playheadTime
    // 再生位置より後の最初の一致(無ければ先頭へ戻る)
    const next = matches.find((o) => o.startTime > now + 1e-3) ?? matches[0]
    onSelect(next.id)
    store.seekTo(next.startTime)
  }

  function replaceAll(): void {
    const n = replaceTelopText(query, replacement, { loose })
    setMessage(n > 0 ? `${n} 本のテロップを置き換えました(取り消せます)` : '見つかりませんでした')
  }

  async function exportSrt(): Promise<void> {
    setMessage(null)
    try {
      const path = await window.api.saveSubtitleFile(
        `${safeFileBaseName(projectName)}.srt`,
        buildSrt(overlays),
        'srt'
      )
      if (path) setMessage(`字幕を書き出しました: ${path}`)
    } catch (e) {
      setMessage(`書き出せませんでした: ${formatIpcError(e)}`)
    }
  }

  async function importSrt(): Promise<void> {
    setMessage(null)
    try {
      const file = await window.api.openSubtitleFile('srt')
      if (!file) return
      const cues = parseSrt(file.text)
      if (cues.length === 0) {
        setMessage('字幕が見つかりませんでした(SRT の形か確かめてください)')
        return
      }
      addTextOverlays(
        cues.map((c) => ({
          text: c.text,
          startTime: c.start,
          endTime: c.end,
          style: defaultTextStyle(),
          source: 'manual' as const
        }))
      )
      setMessage(`${cues.length} 本の字幕を読み込みました`)
    } catch (e) {
      setMessage(`読み込めませんでした: ${formatIpcError(e)}`)
    }
  }

  return (
    <div className="telop-tools">
      <div className="telop-tools-row">
        <button
          type="button"
          className={`small-button ${open ? 'active' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="テロップの文字を探す・まとめて置き換える"
        >
          検索・置換
        </button>
        <button
          type="button"
          className="small-button"
          onClick={() => void importSrt()}
          title="字幕ファイル(SRT)をテロップとして読み込みます(Premiere・YouTube などの字幕)"
        >
          SRT 読み込み
        </button>
        <button
          type="button"
          className="small-button"
          disabled={overlays.length === 0}
          onClick={() => void exportSrt()}
          title="テロップの文字と時刻を字幕ファイル(SRT)に書き出します"
        >
          SRT 書き出し
        </button>
      </div>
      {open && (
        <div className="telop-find" role="search">
          <input
            type="search"
            aria-label="探す文字"
            placeholder="探す文字"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setMessage(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') findNext()
            }}
          />
          <input
            type="text"
            aria-label="置き換える文字"
            placeholder="置き換える文字"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <label
            className="telop-find-loose"
            title="全角・半角、大文字・小文字の違いを無視して探します"
          >
            <input type="checkbox" checked={loose} onChange={(e) => setLoose(e.target.checked)} />
            全角/半角・大小を区別しない
          </label>
          <div className="telop-find-actions">
            <span className="telop-find-count" aria-live="polite">
              {query ? `${matches.length} 本` : ''}
            </span>
            <button
              type="button"
              className="small-button"
              disabled={matches.length === 0}
              onClick={findNext}
            >
              次を探す
            </button>
            <button
              type="button"
              className="small-button"
              disabled={matches.length === 0}
              onClick={replaceAll}
            >
              すべて置換
            </button>
          </div>
        </div>
      )}
      {message && <p className="telop-tools-message">{message}</p>}
    </div>
  )
}
