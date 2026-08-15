import type { Project } from '@shared/types'

/**
 * 2つの企画が**中身として同じ**かどうか。
 *
 * 「同じ値を入れ直しただけ」の操作で履歴を積まないための判定に使う。
 * どの操作も `{ ...state.project }` を作り直すので**参照は必ず別物**になり、
 * `!==` では「変わった」と見分けられない。
 *
 * 企画は保存時に `JSON.stringify` される素の値だけで出来ている(文字列・数値・真偽値・
 * null・配列・素のオブジェクト)ので、**JSON にしたときに同じなら同じ**とみなす。
 * したがって `{ transition: undefined }` と**キーごと無い**のは同じ扱いにする
 * (保存すればどちらも同じファイルになるため。ここを別物と数えると、
 * `{ ...c, transition: undefined }` を作るだけの操作が履歴を積んでしまう)。
 *
 * `JSON.stringify` 同士の比較にしない理由は速さ:
 * 変えていない部分は**参照が同じまま**なので、参照で先に打ち切れる。
 * 文字列化はサムネイルの data URL まで毎回全部なぞることになる。
 */
export function sameProjectContent(a: Project, b: Project): boolean {
  return deepEqual(a, b)
}

function deepEqual(a: unknown, b: unknown): boolean {
  // 参照が同じなら中身も同じ。編集していない配列・クリップはここで打ち切れる
  // (NaN 同士も `Object.is` なら同じと数える。NaN は「値が変わった」ではない)。
  if (Object.is(a, b)) return true

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false

  const aKeys = definedKeys(a)
  if (aKeys.length !== definedKeys(b).length) return false
  const bRecord = b as Record<string, unknown>
  const aRecord = a as Record<string, unknown>
  return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]))
}

/** 値が `undefined` のキーは「無い」と同じ(`JSON.stringify` が落とすため) */
function definedKeys(o: object): string[] {
  const record = o as Record<string, unknown>
  return Object.keys(record).filter((key) => record[key] !== undefined)
}
