import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'

/**
 * 上部バーのプロジェクト名。クリックすると編集できる。
 *
 * 書き出しの既定ファイル名やバッチ書き出しのファイル名はこの名前から作られるので、
 * 変えられないと**別プロジェクトを同じフォルダへ出したときに全部同名になって上書き**
 * されてしまう(名前を書き換える経路が今までどこにも無かった)。
 */
export function ProjectNameField(): React.JSX.Element {
  const projectName = useProjectStore((s) => s.project.name)
  const isDirty = useProjectStore((s) => s.isDirty)
  const setProjectName = useProjectStore((s) => s.setProjectName)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(projectName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function commit(): void {
    // 空白だけのときはストア側が既定名へ戻す。名前が消えた表示を作らない。
    if (draft.trim() !== projectName) setProjectName(draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="project-name-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(projectName)
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="project-name"
      title="クリックしてプロジェクト名を変更"
      onClick={() => {
        setDraft(projectName)
        setEditing(true)
      }}
    >
      {projectName}
      {isDirty && <span className="dirty-dot" title="未保存の変更があります" />}
    </button>
  )
}
