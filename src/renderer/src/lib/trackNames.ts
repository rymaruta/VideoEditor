/**
 * 新しいトラックの名前。まだ使っていない一番小さい番号を付ける。
 * トラックの数から番号を付けると、間のトラックを消した後に同じ名前が2つでき、
 * 素材の右クリックの「〜に追加」がどちらのトラックか分からなくなっていた
 */
export function nextTrackName(prefix: string, existing: readonly string[], first: number): string {
  const used = new Set(existing)
  for (let n = first; ; n++) {
    const name = `${prefix} ${n}`
    if (!used.has(name)) return name
  }
}
