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
import { useProjectStore } from '@renderer/store/projectStore'
import { rippleDeleteRange } from '@renderer/lib/editCommands'
import type { TextOverlay } from '@shared/types'

/**
 * 試し編集 第2回の不具合 1: 確認の画面で文を削除すると、その文の発言テロップが 0.3 秒ずつ残り、書き出しにも
 * 出た。枚は声の少し前(カットの切れ目)から出し、声の後ろも少し延ばすので、文の声の所だけを抜くと、声の前後の
 * 0.3 秒(読めない長さの最短ちょうど)が残っていた。残った所に、その枚の言葉が1文字も無ければ消す
 */
function setup(): void {
  const P = useProjectStore
  P.getState().newProject()
  const asset = (id: string, video: boolean): Record<string, unknown> => ({
    id,
    filePath: `/r/${id}`,
    fileName: id,
    duration: 100,
    width: video ? 1920 : 0,
    height: video ? 1080 : 0,
    hasAudio: true,
    hasVideo: video
  })
  P.setState({
    project: {
      ...P.getState().project,
      assets: [asset('A', true), asset('M', false)] as never,
      multicam: {
        anchorSourceId: 'a',
        sources: [
          { id: 'a', name: 'カメラ', kind: 'camera' },
          { id: 'm', name: 'マイク1', kind: 'mic' }
        ],
        files: [
          { assetId: 'A', sourceId: 'a', start: 0, rate: 1, duration: 100 },
          { assetId: 'M', sourceId: 'm', start: 0, rate: 1, duration: 100 }
        ]
      },
      transcript: [
        {
          id: 'u0',
          assetId: 'M',
          speaker: 'マイク1',
          sourceStart: 1,
          sourceEnd: 4,
          text: 'はじめの文です',
          words: [],
          overlap: false
        },
        {
          id: 'u1',
          assetId: 'M',
          speaker: 'マイク1',
          sourceStart: 5,
          sourceEnd: 11.5,
          text: '直接私が給与袋を手渡した人と違う人があるんで何とも言えませんけども',
          words: [],
          overlap: false
        },
        {
          id: 'u2',
          assetId: 'M',
          speaker: 'マイク1',
          sourceStart: 12,
          sourceEnd: 15,
          text: 'つぎの文です',
          words: [],
          overlap: false
        }
      ] as never
    }
  })
  const chars = (text: string, a: number, b: number): number[] => {
    const n = [...text].length
    return [...text].map((_, i) => a + ((b - a) * (i + 0.5)) / n)
  }
  const telop = (
    text: string,
    utteranceId: string,
    chunk: number,
    startTime: number,
    endTime: number,
    voice: [number, number]
  ): Omit<TextOverlay, 'id'> =>
    ({
      text,
      startTime,
      endTime,
      style: {},
      speaker: 'マイク1',
      source: 'auto',
      utteranceId,
      utteranceChunk: chunk,
      autoSource: {
        start: voice[0],
        end: voice[1],
        text: text.replace(/\n/g, ''),
        times: chars(text.replace(/\n/g, ''), voice[0], voice[1])
      }
    }) as never
  P.getState().applyRoughCut(
    {
      main: [{ assetId: 'A', inPoint: 0, outPoint: 20, speed: 1 }],
      audio: [
        {
          sourceId: 'm',
          name: 'マイク1',
          volume: 1,
          clips: [{ assetId: 'M', startTime: 0, inPoint: 0, outPoint: 20, speed: 1 }]
        }
      ],
      overlays: [],
      duration: 20,
      spans: []
    } as never,
    [
      telop('はじめの文です', 'u0', 0, 1, 4.7, [1.1, 3.9]),
      // 声(5.0〜8.2)より 0.3 秒前(4.7)から出す枚と、声の後ろ(11.5)を 0.3 秒延ばした枚
      telop('直接私が給与袋を\n手渡した人と違う人が', 'u1', 0, 4.7, 8.2, [5.0, 8.2]),
      telop('あるんで何とも\n言えませんけども', 'u1', 1, 8.2, 11.8, [8.2, 11.5]),
      telop('つぎの文です', 'u2', 0, 12, 15, [12.1, 14.9])
    ]
  )
}

describe('確認の画面で文を削除したら、その文の発言テロップを残さない', () => {
  it('声の前後に出していた 0.3 秒の切れ端を残さない(前後の文のテロップはそのまま)', () => {
    setup()
    const before = useProjectStore.getState().project.textOverlays
    expect(before.map((o) => o.utteranceId)).toEqual(['u0', 'u1', 'u1', 'u2'])
    // 文の声の所(5.0〜11.5)を抜く(確認の画面の範囲バーの「削除」と同じ)
    expect(rippleDeleteRange(5.0, 11.5)).toBe(true)
    const after = useProjectStore.getState().project.textOverlays
    expect(after.filter((o) => o.utteranceId === 'u1')).toEqual([])
    expect(after.map((o) => o.utteranceId)).toEqual(['u0', 'u2'])
    const next = after.find((o) => o.utteranceId === 'u2')!
    expect(next.startTime).toBeCloseTo(5.5, 6)
  })

  it('言葉の残る所は今までどおり残す(文の後ろ半分だけを抜いたとき)', () => {
    setup()
    // 1枚目の声(5.0〜8.2)の後ろ半分から2枚目の終わりまでを抜く。1枚目の頭の 1.9 秒には言葉がある
    expect(rippleDeleteRange(6.6, 11.8)).toBe(true)
    const after = useProjectStore.getState().project.textOverlays
    const u1 = after.filter((o) => o.utteranceId === 'u1')
    expect(u1).toHaveLength(1)
    expect(u1[0].startTime).toBeCloseTo(4.7, 6)
    expect(u1[0].endTime).toBeCloseTo(6.6, 6)
  })

  // 監査 A: 速さを変えたクリップでは、タイムラインの秒と素材の秒が 1:1 でない
  it('速さ 2 のクリップでも、言葉の残る枚は消さない', () => {
    setup()
    const P = useProjectStore
    P.getState().updateClipSpeed(P.getState().project.clips[0].id, 2)
    const u2 = P.getState().project.textOverlays.find((o) => o.utteranceId === 'u2')!
    // u2 の声(素材 12.1〜14.9 秒)はタイムラインの 6.05〜7.45 秒。7.0〜7.6 を抜いても頭の 1 秒は残る
    expect(u2.startTime).toBeCloseTo(6, 6)
    expect(rippleDeleteRange(7.0, 7.6)).toBe(true)
    const after = P.getState().project.textOverlays.filter((o) => o.utteranceId === 'u2')
    expect(after).toHaveLength(1)
    expect(after[0].endTime).toBeCloseTo(7.0, 6)
  })

  it('速さ 0.5 のクリップでも、言葉の残る枚は消さない(声の前だけ残る枚は消す)', () => {
    setup()
    const P = useProjectStore
    P.getState().updateClipSpeed(P.getState().project.clips[0].id, 0.5)
    const u2 = P.getState().project.textOverlays.find((o) => o.utteranceId === 'u2')!
    expect(u2.startTime).toBeCloseTo(24, 6)
    // 素材 12.1〜14.9 秒の声はタイムラインの 24.2〜29.8 秒。25.5〜30.5 を抜くと頭の 1.5 秒(言葉あり)が残る
    expect(rippleDeleteRange(25.5, 30.5)).toBe(true)
    expect(P.getState().project.textOverlays.filter((o) => o.utteranceId === 'u2')).toHaveLength(1)
    // u1 の 2 枚目(素材 8.2〜11.5 秒 = タイムライン 16.4〜23.6 秒)を、言葉の所ごと抜くと消える
    expect(rippleDeleteRange(16.4, 23.0)).toBe(true)
    const u1 = P.getState().project.textOverlays.filter((o) => o.utteranceId === 'u1')
    expect(u1.map((o) => o.utteranceChunk)).toEqual([0])
  })
})
