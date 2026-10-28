import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { projectFingerprint, runEpisode } from '../helpers/episodeHarness'

/**
 * 範囲の自動編集・ロックを足す前(91ce266)の作り直しの結果の指紋。
 * (試し編集 第2回の直しで、企画に覚える自動編集の判断に「SE・BGM・CG の工程の終わり方」(`soundDone`)と
 * 「演出テロップの提案を省いた理由」(`effectsSkipped`)が増えた分だけ値を直した。この2つを除いた指紋は
 * 前の値 29386:61599fc6 9779:bb562d7 19224:7625a6b7 のまま。再監査の直しで、場面を選んだ時の方針
 * (`dropBasis`)が増えた分も直した。これを除いた指紋は 29478:9eb3a69d 9871:b46015f4 19316:10de5e97 のまま。
 * 試し編集 第4回 N3 の直しで、長さで落とした場面の決め手(`dropBasis.lengthBy`)が保存されるようになった
 * 分も直した。`lengthBy` を除いた指紋は 29575:934f592d 9969:a9359ac3 19508:adbd433c のまま)
 * ロックも範囲も使わない企画では、
 * 作り直しの道が1つも変わらないことを確かめる(変わったら、このファイルの値を直す前に理由を確かめる)
 */
const KIT = {
  se: {
    ツッコミ: [{ path: '/kit/SE/ツッコミ/a.wav', name: 'a.wav', duration: 1.2 }],
    場面転換: [{ path: '/kit/SE/場面転換/b.wav', name: 'b.wav', duration: 0.8 }]
  },
  bgm: {
    楽しい: [{ path: '/kit/BGM/楽しい/c.mp3', name: 'c.mp3', duration: 40 }],
    穏やか: [{ path: '/kit/BGM/穏やか/d.mp3', name: 'd.mp3', duration: 25 }]
  },
  cg: { おいしい: [{ path: '/kit/CG/おいしい/e.png', name: 'e.png', duration: 0, still: true }] }
}

async function scenario(): Promise<string> {
  await runEpisode(
    () => {
      useSettingsStore.setState({ showKitFolder: '/kit' } as never)
    },
    {
      showKitScan: async () => KIT,
      // 画像の CG は素材の読み込み(画像の大きさを測る)が要るので、映像の素材として読ませる
      probeMedia: async (path: string) => ({
        duration: path.startsWith('/kit') ? 40 : 240,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        hasVideo: !path.endsWith('.wav') && !path.endsWith('.mp3'),
        videoCodec: 'h264',
        audioCodec: 'aac',
        needsPreviewProxy: false
      })
    }
  )
  const parts: string[] = [projectFingerprint(useProjectStore.getState().project)]
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
  parts.push(projectFingerprint(useProjectStore.getState().project))
  // 手で詰め・消し、落ちた場面を残して作り直す
  const clips = useProjectStore.getState().project.clips
  const longest = clips.reduce((a, c) => (c.outPoint - c.inPoint > a.outPoint - a.inPoint ? c : a))
  useProjectStore.getState().updateClipTrim(longest.id, longest.inPoint, longest.outPoint - 3)
  useProjectStore.getState().removeClip(useProjectStore.getState().project.clips[0].id)
  const s = usePipelineStore.getState()
  const dropped = s.scenes.map((sc) => sc.id).filter((id) => !s.roughCut!.keptIds.includes(id))
  usePipelineStore.getState().setKeep(dropped[0], true)
  await usePipelineStore.getState().rebuildRoughCut()
  const p = usePipelineStore.getState()
  parts.push(
    projectFingerprint({
      project: useProjectStore.getState().project,
      roughCut: p.roughCut,
      builtKept: p.builtKept,
      keepTouched: p.keepTouched,
      past: useProjectStore.getState().past.length
    })
  )
  return parts.join(' ')
}

describe('ロックも範囲も使わない作り直しは、足す前と同じ', () => {
  it('作り直しの結果の指紋が 91ce266 と一致する', async () => {
    const got = await scenario()
    expect(got).toBe('29575:934f592d 10006:1a096281 19558:3ae097d4')
  })
})
