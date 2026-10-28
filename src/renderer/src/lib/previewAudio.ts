/**
 * プレビューの音で共有するもの: `AudioContext` と、要素ごとの音量用 `GainNode`。
 *
 * `AudioContext` は再生要素ごとに作ると出力デバイスを食い潰すので 1 つだけ持つ。
 * **要求されたときにだけ**作る(1 倍を超える音量・ダッキング・音量計)。
 */
let sharedAudioContext: AudioContext | null = null
export function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext) return sharedAudioContext
  try {
    sharedAudioContext = new AudioContext()
  } catch {
    sharedAudioContext = null
  }
  return sharedAudioContext
}

/** 作ってあれば返す(作らない) */
export function existingAudioContext(): AudioContext | null {
  return sharedAudioContext
}

/**
 * 要素の音量を `GainNode` が持っているとき、その `GainNode`(音量計が「聞こえている大きさ」を
 * 出すために読む)。要素の `volume` はノードより手前に掛かる
 */
const elementGainNodes = new WeakMap<HTMLMediaElement, GainNode>()
export function noteElementGainNode(el: HTMLMediaElement, gain: GainNode): void {
  elementGainNodes.set(el, gain)
}

/** この要素がいま聞こえている倍率(素の音に対して)。消音なら 0 */
export function audibleGainOf(el: HTMLMediaElement): number {
  if (el.muted) return 0
  const node = elementGainNodes.get(el)
  const g = el.volume * (node ? node.gain.value : 1)
  return Number.isFinite(g) ? Math.max(0, g) : 0
}
