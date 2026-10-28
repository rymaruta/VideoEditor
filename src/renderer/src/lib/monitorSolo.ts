/**
 * 音声トラックのソロ(モニター用)。プレビューの音だけに効き、書き出しには効かない
 * (Premiere・Resolve と同じ)。ソロが 1 本でもあれば、聞こえるのはソロのトラックだけで、
 * 本編とワイプの音も鳴らさない。
 */

/** 今あるトラックのうち、ソロにしているものの id(消したトラックの id は数えない) */
export function activeSoloIds(
  soloTrackIds: readonly string[],
  tracks: readonly { id: string }[]
): string[] {
  return soloTrackIds.filter((id) => tracks.some((t) => t.id === id))
}

/** この音声トラックをプレビューで鳴らさないか(ミュート、またはほかのトラックのソロ) */
export function trackSilencedInPreview(
  track: { id: string; muted: boolean },
  activeSolo: readonly string[]
): boolean {
  if (track.muted) return true
  return activeSolo.length > 0 && !activeSolo.includes(track.id)
}

/** 本編・ワイプの音(音声トラックでない音)をソロのために鳴らさないか */
export function nonTrackAudioSilencedBySolo(activeSolo: readonly string[]): boolean {
  return activeSolo.length > 0
}
