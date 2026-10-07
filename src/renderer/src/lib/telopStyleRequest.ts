import { create } from 'zustand'

/**
 * テロップスタイルの管理を、メニュー以外の所から開く頼み。
 * `speech` は「発言テロップの見た目」の欄から開いたとき: 今の発言テロップの見た目を開き、
 * 「この見た目を使う」でその見た目を自動の発言テロップに使う(自動編集の前に、見た目を自分で作れるように)。
 */
interface TelopStyleRequest {
  request: { mode: 'speech'; restyleExisting: boolean } | null
  /** `restyleExisting`: OK で、今の企画に入っている自動の発言テロップも替える */
  openForSpeech: (restyleExisting: boolean) => void
  clear: () => void
}

export const useTelopStyleRequest = create<TelopStyleRequest>((set) => ({
  request: null,
  openForSpeech: (restyleExisting) => set({ request: { mode: 'speech', restyleExisting } }),
  clear: () => set({ request: null })
}))
