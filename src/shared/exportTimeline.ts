/**
 * **タイムラインの秒 → 書き出しの秒**の換算。
 *
 * 繋ぎ(クロスフェードなど)は2本のクリップを**重ねる**ので、出来上がる動画は
 * タイムラインより繋ぎの秒数ぶん短い。テロップ・BGM・効果音・PiP はどれも
 * **タイムラインの秒**で置かれているので、この換算を通さないと繋ぎより後ろの物が
 * まとめて後ろへずれる。
 *
 * ここを共通の置き場に1つ置くのは、**区間の両端を別々の規則で換算させない**ため。
 * 端ごとに `toExportTime` を掛けるのは誤りで、必ず対で
 * (`toExportTime` + `toExportEndTime`)通す。理由は `toExportEndTime` のコメント。
 */

export interface ExportTimeMap {
  /** タイムラインの秒 → 書き出しの秒(区間の**始まり**用) */
  toExportTime(timelineTime: number): number
  /** タイムラインの区間 → 書き出しの秒(区間の**終わり**用) */
  toExportEndTime(startTimeline: number, endTimeline: number): number
}

/**
 * @param timelineStarts   各クリップがタイムラインで始まる秒(先頭から詰めて並べたもの)
 * @param timelineDurations 各クリップのタイムライン上の長さ(秒)
 * @param exportStarts     各クリップが**書き出しの中で**始まる秒(繋ぎのぶん重なる)
 */
export function createExportTimeMap(
  timelineStarts: readonly number[],
  timelineDurations: readonly number[],
  exportStarts: readonly number[]
): ExportTimeMap {
  // クリップが1本も無いときは換算しようがない。ここで素通しにしておかないと
  // 添字が `undefined` になり、置いた物の位置が全部 NaN になる。
  if (timelineStarts.length === 0) {
    return {
      toExportTime: (t) => t,
      toExportEndTime: (s, e) => Math.max(s, e)
    }
  }

  const clipIndexAt = (timelineTime: number): number => {
    let idx = 0
    for (let i = 0; i < timelineStarts.length; i++) {
      if (timelineStarts[i] <= timelineTime) idx = i
      else break
    }
    return idx
  }

  const toExportTime = (timelineTime: number): number => {
    const idx = clipIndexAt(timelineTime)
    return Math.max(0, timelineTime - (timelineStarts[idx] - exportStarts[idx]))
  }

  /**
   * **区間の「終わり」の換算。始まりと必ず対で使う。**
   *
   * `toExportTime` は**単調ではない**。繋ぎはクリップの変わり目で2本を重ねるので、
   * 返る値がそこで**繋ぎの秒数ぶん巻き戻る**(実測・4秒+4秒に1秒のクロスフェード:
   * `toExportTime(3.99)` = 3.99 に対し `toExportTime(4.0)` = **3.0**)。
   * そのため**繋ぎをまたぐ区間**を端ごとに換算すると、終わりが始まりより**前**になる。
   *
   * これを ASS の `Dialogue` にそのまま書くと、libass は行を消す時刻を見失い
   * **動画の最後まで出しっぱなし**にする(実測: タイムライン [3.7, 4.3] に置いた
   * テロップが、7.000秒の出力で **3.733秒から 6.967秒＝最後まで**焼き込まれた)。
   * 対になる失敗が「**終わりだけ換算し忘れて、始まり + 素材の尺のままにする**」で、
   * こちらは黙って長く残る(実測: タイムライン [2.0, 6.0] の BGM が、正しい 5.0秒を
   * 過ぎて **6.0秒まで鳴っていた**)。
   *
   * 正しい終わりは「その区間が覆う**書き出し時刻の集合**」の右端。区間が繋ぎを
   * またいでいるなら、またいだクリップの**終わりまでは覆っている**ので、
   * それも候補に入れて一番大きいものを採る。ここを「終わりが始まりより前のときだけ
   * 差し替える」と書くと、**区間がクリップの境目ちょうどで終わるとき**に取りこぼす
   * (境目では両者が同じ値になるため差し替えが効かず、長さ0の区間になって
   * テロップも音も**丸ごと消える**)。戻り値が始まりより前になることは無い。
   */
  const toExportEndTime = (startTimeline: number, endTimeline: number): number => {
    const startExport = toExportTime(startTimeline)
    const startIdx = clipIndexAt(startTimeline)
    const endIdx = clipIndexAt(endTimeline)
    let endExport = toExportTime(endTimeline)
    for (let i = startIdx; i < endIdx; i++) {
      const clipEnd = exportStarts[i] + timelineDurations[i]
      // NaN は `>` でも `<` でも false を返すので、大小比べだけでは差し替わらない。
      // 逆に Infinity は「一番大きい」で正しいので、潰してよいのは NaN だけ。
      if (Number.isNaN(endExport) || clipEnd > endExport) endExport = clipEnd
    }
    // 終わりが数値でない区間。少なくとも始まりのクリップの終わりまでは覆っている
    // とみなす(ここで NaN を返すと、受け取った側が「消す時刻」を失う)。
    if (Number.isNaN(endExport)) {
      endExport = exportStarts[startIdx] + timelineDurations[startIdx]
    }
    return Math.max(startExport, endExport)
  }

  return { toExportTime, toExportEndTime }
}
