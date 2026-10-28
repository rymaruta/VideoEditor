import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoicevoxStore } from '@renderer/store/voicevoxStore'

/**
 * VOICEVOX へは、ナレーションのパネルを開いた時に初めてつなぐ。前はパネルを置いた時(起動の直後)に
 * つないでいて、ナレーションを使わない人でも起動のたびに接続のエラーがメインの記録に残っていた。
 */

const listSpeakers = vi.fn()

beforeEach(() => {
  listSpeakers.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { voicevoxListSpeakers: listSpeakers }
  }
  useVoicevoxStore.setState({ status: 'idle', speakers: [], error: null })
})

describe('VOICEVOX につなぐ時', () => {
  it('読み込んだだけではつながない', () => {
    expect(useVoicevoxStore.getState().status).toBe('idle')
    expect(listSpeakers).not.toHaveBeenCalled()
  })

  it('パネルを開いたら1回だけつなぎ、開き直しても繰り返さない', async () => {
    listSpeakers.mockResolvedValue([{ name: 'ずんだもん', styles: [{ id: 3, name: 'ノーマル' }] }])
    useVoicevoxStore.getState().connectIfNeeded()
    useVoicevoxStore.getState().connectIfNeeded()
    await vi.waitFor(() => expect(useVoicevoxStore.getState().status).toBe('ready'))
    useVoicevoxStore.getState().connectIfNeeded()
    expect(listSpeakers).toHaveBeenCalledTimes(1)
    expect(useVoicevoxStore.getState().speakers[0].name).toBe('ずんだもん')
  })

  it('つなげなければ理由を出し、勝手につなぎ直さない(「再接続」で頼み直す)', async () => {
    listSpeakers.mockRejectedValueOnce(new Error('VOICEVOX Engineに接続できません'))
    useVoicevoxStore.getState().connectIfNeeded()
    await vi.waitFor(() => expect(useVoicevoxStore.getState().status).toBe('error'))
    expect(useVoicevoxStore.getState().error).toContain('VOICEVOX Engineに接続できません')
    useVoicevoxStore.getState().connectIfNeeded()
    expect(listSpeakers).toHaveBeenCalledTimes(1)
    listSpeakers.mockResolvedValueOnce([])
    await useVoicevoxStore.getState().connect()
    expect(listSpeakers).toHaveBeenCalledTimes(2)
    expect(useVoicevoxStore.getState().status).toBe('ready')
  })
})
