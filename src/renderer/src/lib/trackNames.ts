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

/**
 * 新しく作るトラックの既定の名前の頭(「動画 2」「音声 4」)。トラックの見出しの名前の欄は狭いので短く
 * (「音声トラック 4」は「音声トラ…」と省かれていた)。種類は名札(V2・A4)と見出しの印でも分かる
 */
export const NEW_VIDEO_TRACK_PREFIX = '動画'
export const NEW_AUDIO_TRACK_PREFIX = '音声'
