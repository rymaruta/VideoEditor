/**
 * **出力に素材のメタデータ・チャプターを持ち込まない**(書き出し・プロキシ・取り出した音声のどれも付ける)。
 *
 * ffmpeg は指定が無いと、最初の入力の全体のメタデータ(題名・位置情報)と、チャプターを持つ最初の入力の
 * チャプターを出力へ写す。`-map` で選んだ映像・音声だけを出していても、これは別に写る。
 * (実地テスト: Android の MP4 の位置情報 `location`/`location-eng` と題名が書き出した動画に残った。
 *  チャプター6個付きの m4a を BGM に置くと、4 秒の動画にチャプター6個と 1650 秒のテキストトラックが付き、
 *  同梱の ffprobe 4.0.2 が長さを 1650 秒と読んで、QC が「1646 秒の止まり・無音」と誤検知した)
 * データ・字幕のトラックも持ち込まない(`-map` を付けない経路で、素材のものが写る)
 */
export const NO_SOURCE_METADATA_ARGS = ['-map_metadata', '-1', '-map_chapters', '-1', '-dn', '-sn']

/** 素材の映像の色と走査の情報(ffprobe の `color_transfer` などをそのまま持つ) */
export interface SourceVideoInfo {
  colorTransfer?: string
  colorPrimaries?: string
  colorSpace?: string
  colorRange?: string
  fieldOrder?: string
}

/** HDR の伝達特性(PQ = smpte2084、HLG = arib-std-b67) */
export function isHdrTransfer(transfer: string | undefined): boolean {
  return transfer === 'smpte2084' || transfer === 'arib-std-b67'
}

/** インターレース(ffprobe の field_order が tt/bb/tb/bt。progressive・unknown・無しは違う) */
export function isInterlacedFieldOrder(fieldOrder: string | undefined): boolean {
  return fieldOrder === 'tt' || fieldOrder === 'bb' || fieldOrder === 'tb' || fieldOrder === 'bt'
}

/**
 * HDR を SDR に寄せるときの、SDR の白(100%)に当てる明るさ(cd/m²)。BT.2408 の「HDR の基準の白」。
 * iPhone の HLG・PQ の撮影は、紙の白・肌をこの辺りに置いている。ここを 100% にし、それより明るい所
 * (空・光源)だけを `mobius` で丸めると、SDR の素材と並べても明るさ・色の濃さが揃う
 * (実測: SDR で (159,103,67) の色を PQ・HLG にした素材が、(158,103,67) に戻る。`hable` で npl=100 だと
 *  (136,89,57)、何もしないと PQ (111,96,76)・HLG (124,97,65))
 */
export const HDR_REFERENCE_WHITE_NITS = 203

/** zscale の行列の名前(ffprobe の color_space から)。分からなければ BT.2020 の非定輝度 */
function zscaleMatrix(space: string | undefined): string {
  return space === 'bt2020c' ? '2020_cl' : '2020_ncl'
}

/**
 * 素材の映像の頭に掛けるフィルタ(末尾に `,` を付けて返す。何も要らなければ空文字)。
 *
 * - **インターレース**の素材は `bwdif` で解除する(1コマ → 1コマ。フレームレートは変えない)。
 *   解除せずに縮めると、上下のフィールドが混ざって動く輪郭が櫛状になっていた
 * - **HDR(PQ・HLG)**の素材は SDR(BT.709)へトーンマッピングする。そのまま 8bit に落とすと、
 *   PQ・HLG の符号値を BT.709 として読むので暗く色が薄くなっていた(PQ (84,72,57)、HLG (95,75,51)、
 *   期待 ≈ (159,103,67))。`zscale` が使えれば線形にして `tonemap=mobius`、使えなければ
 *   同じ曲線の表引きで近似する(`hdrToSdrLutFilter`)
 *
 * SDR・プログレッシブの素材は空文字(今までの書き出しを1バイトも変えない)
 */
export function sourceVideoFilter(
  info: SourceVideoInfo | undefined,
  options: { zscale: boolean }
): string {
  if (!info) return ''
  const parts: string[] = []
  if (isInterlacedFieldOrder(info.fieldOrder)) {
    parts.push('bwdif=mode=send_frame:parity=auto:deint=all')
  }
  if (isHdrTransfer(info.colorTransfer)) {
    if (options.zscale) {
      const rin = info.colorRange === 'pc' ? 'full' : 'limited'
      parts.push(
        `zscale=tin=${info.colorTransfer}:min=${zscaleMatrix(info.colorSpace)}:pin=bt2020:rin=${rin}:` +
          `t=linear:npl=${HDR_REFERENCE_WHITE_NITS}`,
        'format=gbrpf32le',
        'zscale=p=bt709',
        'tonemap=tonemap=mobius:desat=0',
        'zscale=t=bt709:m=bt709:r=limited',
        'format=yuv420p'
      )
    } else {
      parts.push(hdrToSdrLutFilter(info.colorTransfer === 'smpte2084' ? 'pq' : 'hlg'))
    }
  }
  return parts.length > 0 ? `${parts.join(',')},` : ''
}

/** 式に入れる数(指数表記を出さない) */
const n = (x: number): string => x.toFixed(6)

/**
 * `zscale` の無い ffmpeg で使う、HDR → SDR の近似(16bit の表引き)。
 *
 * 1. BT.2020 の行列で RGB(16bit)にする
 * 2. 各色を PQ の EOTF(HLG は逆 OETF と 1000 cd/m² の OOTF ≈ 1000×E^1.2)で明るさ(cd/m²)にし、
 *    基準の白(203 cd/m²)を 1 として `mobius`(zscale の経路と同じ曲線。上限は 1000 cd/m²)で丸める
 * 3. 線形のまま BT.2020 → BT.709 の色域へ移す(`colorchannelmixer`。BT.2087 の行列)
 * 4. BT.1886 の逆(1/2.4 乗)で符号値に戻し、BT.709 の行列で YUV にする
 *
 * 明るさの丸めを色ごとに掛けるので、基準の白より明るい色(空・光源)は zscale の経路より少し色が薄くなる。
 * 基準の白までの色は zscale の経路と同じになる(実測: どちらも (158,103,67))
 */
export function hdrToSdrLutFilter(kind: 'pq' | 'hlg'): string {
  const e = '(val/maxval)'
  let nits: string
  if (kind === 'pq') {
    const p = `pow(${e},1/78.84375)`
    nits = `(10000*pow(max(${p}-0.8359375,0)/(18.8515625-18.6875*${p}),1/0.1593017578125))`
  } else {
    const lin = `if(lte(${e},0.5),${e}*${e}/3,(exp((${e}-0.55991073)/0.17883277)+0.28466892)/12)`
    nits = `(1000*pow(${lin},1.2))`
  }
  const x = `(${nits}/${HDR_REFERENCE_WHITE_NITS})`
  // ffmpeg の tonemap の mobius と同じ式(j = 0.3)
  const j = 0.3
  const peak = 1000 / HDR_REFERENCE_WHITE_NITS
  const a = (-j * j * (peak - 1)) / (j * j - 2 * j + peak)
  const b = (j * j - 2 * j * peak + peak) / (peak - 1)
  const k = (b * b + 2 * b * j + j * j) / (b - a)
  const toLinear = `maxval*min(1,if(lte(${x},${n(j)}),${x},${n(k)}*(${x}+${n(a)})/(${x}+${n(b)})))`
  const toCode = `maxval*pow(val/maxval,1/2.4)`
  const lut = (expr: string): string => `lutrgb=r='${expr}':g='${expr}':b='${expr}'`
  return [
    'scale=in_color_matrix=bt2020:in_range=tv:out_range=pc',
    'format=gbrp16le',
    lut(toLinear),
    'colorchannelmixer=rr=1.6605:rg=-0.5876:rb=-0.0728:gr=-0.1246:gg=1.1329:gb=-0.0083:br=-0.0182:bg=-0.1006:bb=1.1187',
    lut(toCode),
    'scale=out_color_matrix=bt709:out_range=tv',
    'format=yuv420p'
  ].join(',')
}

/** HDR を SDR に寄せて書き出した動画に付ける色のタグ(BT.709) */
export const SDR_COLOR_TAG_ARGS = [
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709'
]
