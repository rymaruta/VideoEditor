import type { TelopGradient, TextStyle } from '../types'
import { defaultTextStyle } from '../textStyle'

/**
 * テロップの型(テンプレート)。番組でよく使う見た目を、用途ごとに名前を付けて揃えたもの。
 * テロップの種類の一覧(`kinds.ts`)に「手で置く」種類として並ぶ。見た目はすべて共通テロップレンダラで描ける値だけで作る。
 *
 * 作り方の決まり(どの型も同じ品質にするため):
 * - 下の発言テロップの位置(下から 8%)と重ならない所に置く(情報は上・左上・右上、人物は左下)
 * - 縁は文字の大きさの 1/10 前後。漢字の多い文は極太書体に太い縁を付けない(中がつぶれる)
 * - 色の組は、どんな画の上でも読める明暗の差を付ける(明るい文字に暗い縁、暗い文字に明るい板)
 * - 絵文字は使わない(PC によって字形が無く、書き出しで豆腐になる)
 */

export type TelopCategory =
  | 'speech'
  | 'reaction'
  | 'sfx'
  | 'info'
  | 'people'
  | 'structure'
  | 'game'
  | 'play'
  | 'social'
  | 'emotion'

export const CATEGORY_LABEL: Record<TelopCategory, string> = {
  speech: '発言',
  reaction: 'ツッコミ・リアクション',
  sfx: '擬音',
  info: '情報',
  people: '人物',
  structure: '番組構成',
  game: 'クイズ・ゲーム',
  play: 'ゲーム実況',
  social: 'SNS・配信',
  emotion: '感情'
}

export const CATEGORY_ORDER: readonly TelopCategory[] = [
  'speech',
  'reaction',
  'sfx',
  'emotion',
  'info',
  'people',
  'structure',
  'game',
  'play',
  'social'
]

export interface TelopTemplate {
  id: string
  label: string
  category: TelopCategory
  use: string
  sample: string
  seconds: number
  style: () => TextStyle
}

/** 色を等間隔に並べたグラデーション */
const grad = (angle: number, ...colors: string[]): TelopGradient => ({
  angle,
  stops: colors.map((color, i) => ({ at: colors.length > 1 ? i / (colors.length - 1) : 0, color }))
})

const GOLD = grad(0, '#fff8c4', '#ffd54f', '#ff8f00')
const SILVER = grad(0, '#ffffff', '#cfd8dc', '#78909c')
const FIRE = grad(0, '#fff59d', '#ff9800', '#d50000')
const RAINBOW = grad(90, '#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb')

/** 型を1つ作る。`style` は既定の見た目に重ねる値 */
const tpl = (
  id: string,
  label: string,
  category: TelopCategory,
  use: string,
  sample: string,
  seconds: number,
  style: Partial<TextStyle>
): TelopTemplate => ({
  id: `tpl-${id}`,
  label,
  category,
  use,
  sample,
  seconds,
  style: () => defaultTextStyle({ fontFamily: 'Noto Sans JP', bold: true, ...style })
})

// 置き場所(キャンバスに対する比)
const TOP_LEFT = { x: 0.2, y: 0.11 }
const TOP_RIGHT = { x: 0.82, y: 0.11 }
const LOWER_LEFT = { x: 0.22, y: 0.76 }

export const TELOP_TEMPLATES: readonly TelopTemplate[] = [
  // ---------------------------------------------------------------- 発言
  tpl(
    'speech-standard',
    '発言(白・黒縁)',
    'speech',
    '発言テロップの基本。自動編集の既定',
    'ここが中華街の入り口です',
    2.5,
    {
      fontWeight: 800,
      fontSize: 52,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 7
    }
  ),
  tpl(
    'speech-yellow',
    '発言(黄)',
    'speech',
    '目立たせたい発言を黄色で',
    'これは絶対うまいやつ!',
    2.5,
    {
      fontWeight: 800,
      fontSize: 50,
      color: '#ffe600',
      outlineColor: '#000000',
      outlineWidth: 7
    }
  ),
  tpl(
    'speech-band',
    '発言(黒帯)',
    'speech',
    '画が明るく文字が読みにくい場面の発言',
    'ここで少し休憩しましょう',
    2.5,
    {
      fontWeight: 700,
      fontSize: 46,
      outline: false,
      background: true,
      backgroundColor: '#000000',
      backgroundOpacity: 0.62,
      backgroundRadius: 4
    }
  ),
  tpl(
    'speech-blue',
    '発言(青縁)',
    'speech',
    '話者ごとに色を分けるときの1人目',
    'じゃあ行ってみようか',
    2.5,
    {
      fontWeight: 800,
      fontSize: 50,
      outlineColor: '#0d47a1',
      outlineWidth: 7,
      extraStrokes: [{ color: '#ffffff', width: 3 }]
    }
  ),
  tpl(
    'speech-pink',
    '発言(ピンク縁)',
    'speech',
    '話者ごとに色を分けるときの2人目',
    'えー、本当ですか?',
    2.5,
    {
      fontWeight: 800,
      fontSize: 50,
      outlineColor: '#c2185b',
      outlineWidth: 7,
      extraStrokes: [{ color: '#ffffff', width: 3 }]
    }
  ),
  tpl(
    'speech-green',
    '発言(緑縁)',
    'speech',
    '話者ごとに色を分けるときの3人目',
    'ここ、昔来たことあるよ',
    2.5,
    {
      fontWeight: 800,
      fontSize: 50,
      outlineColor: '#1b5e20',
      outlineWidth: 7,
      extraStrokes: [{ color: '#ffffff', width: 3 }]
    }
  ),
  tpl(
    'speech-orange',
    '発言(オレンジ縁)',
    'speech',
    '話者ごとに色を分けるときの4人目(コラボ)',
    'いや今の絶対当たってたって',
    2.5,
    {
      fontWeight: 800,
      fontSize: 50,
      outlineColor: '#e65100',
      outlineWidth: 7,
      extraStrokes: [{ color: '#ffffff', width: 3 }]
    }
  ),
  tpl(
    'speech-purple',
    '発言(紫縁)',
    'speech',
    '話者ごとに色を分けるときの5人目(コラボ)',
    'こっちに回復あるよ',
    2.5,
    {
      fontWeight: 800,
      fontSize: 50,
      outlineColor: '#4a148c',
      outlineWidth: 7,
      extraStrokes: [{ color: '#ffffff', width: 3 }]
    }
  ),
  tpl('speech-whisper', '小声', 'speech', 'ひそひそ話・独り言', '(ちょっと高くない?)', 2.5, {
    fontWeight: 500,
    fontSize: 36,
    color: '#eceff1',
    outlineColor: '#263238',
    outlineWidth: 4,
    opacity: 0.88,
    animation: 'fadeIn'
  }),
  tpl('speech-shout', '叫び', 'speech', '大声・絶叫', 'うわあああ!', 2, {
    fontWeight: 900,
    fontSize: 72,
    outlineColor: '#c62828',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    animation: 'popIn',
    loopAnimation: 'shake'
  }),
  tpl('speech-phone', '電話の声', 'speech', '電話・通話相手の声', 'もしもし、今どこにいるの?', 3, {
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 700,
    fontSize: 42,
    color: '#e1f5fe',
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#01303f',
    backgroundOpacity: 0.78,
    backgroundRadius: 28,
    backgroundBorder: { color: '#4fc3f7', width: 3 },
    backgroundPadding: { x: 28, y: 10 }
  }),
  tpl(
    'speech-radio',
    '無線・スピーカー',
    'speech',
    'トランシーバー・場内放送の声',
    'こちら本部、聞こえますか',
    3,
    {
      fontWeight: 700,
      fontSize: 42,
      color: '#ccff90',
      outlineColor: '#1b3a0b',
      outlineWidth: 5,
      letterSpacing: 3
    }
  ),
  tpl(
    'speech-vertical',
    '縦書きの発言',
    'speech',
    '画面の右端に縦で出す発言',
    'ここが噂の\n絶景スポットか',
    3,
    {
      vertical: true,
      customPosition: { x: 0.9, y: 0.45 },
      fontWeight: 800,
      fontSize: 52,
      outlineColor: '#000000',
      outlineWidth: 7
    }
  ),
  tpl(
    'speech-quote',
    '本人談(引用)',
    'speech',
    'インタビュー・本人の言葉を引用で',
    '「毎朝ここで海を見るのが日課です」',
    3.5,
    {
      fontFamily: 'M PLUS Rounded 1c',
      fontWeight: 700,
      fontSize: 40,
      outline: false,
      position: 'bottom',
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#1b2a4a',
      backgroundOpacity: 0.86,
      backgroundRadius: 10,
      backgroundPadding: { x: 28, y: 12 }
    }
  ),
  tpl(
    'speech-english',
    '英語字幕',
    'speech',
    '外国語をそのまま字幕で',
    "It's absolutely amazing!",
    3,
    {
      fontWeight: 500,
      fontSize: 42,
      outlineColor: '#000000',
      outlineWidth: 3
    }
  ),

  // ---------------------------------------------------------------- ツッコミ・リアクション
  tpl('react-red', '驚き(赤縁)', 'reaction', '驚き・強いツッコミ', 'マジで!?', 2, {
    position: 'center',
    fontWeight: 900,
    fontSize: 84,
    outlineColor: '#d50000',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    animation: 'bounce'
  }),
  tpl('react-gold', '金の決め文字', 'reaction', '名言・決め台詞を金色で', '神回確定', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 92,
    color: '#ffd54f',
    fillGradient: GOLD,
    outlineColor: '#4e2600',
    outlineWidth: 7,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    shadow: true,
    shadowBlur: 12,
    shadowDistance: 6,
    shadowOpacity: 0.5,
    animation: 'popIn'
  }),
  tpl('react-fire', '炎', 'reaction', '熱い・辛い・燃える場面', '激辛!!', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 96,
    color: '#ff9800',
    fillGradient: FIRE,
    outlineColor: '#3e0000',
    outlineWidth: 7,
    glow: { color: '#ff6f00', size: 22, opacity: 0.65 },
    animation: 'popIn',
    loopAnimation: 'shake'
  }),
  tpl('react-neon', 'ネオン', 'reaction', '夜・おしゃれな決め', 'さすが!', 2.5, {
    position: 'center',
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 76,
    color: '#ffffff',
    outlineColor: '#ff4fd8',
    outlineWidth: 3,
    glow: { color: '#ff2fd0', size: 30, opacity: 0.9 },
    animation: 'fadeIn',
    loopAnimation: 'pulse'
  }),
  tpl('react-diagonal', '斜め帯', 'reaction', '展開を締める一言を斜めの帯で', 'まさかの展開', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 64,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#d50000',
    backgroundOpacity: 0.95,
    backgroundSkew: -12,
    backgroundPadding: { x: 44, y: 10 },
    shadow: true,
    shadowBlur: 10,
    shadowDistance: 6,
    shadowOpacity: 0.45,
    animation: 'slideInUp'
  }),
  tpl('react-big', '特大文字', 'reaction', '画面いっぱいの驚き', 'えーっ!!', 2, {
    position: 'center',
    fontWeight: 900,
    fontSize: 150,
    outlineColor: '#000000',
    outlineWidth: 11,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    animation: 'none',
    charAnimation: 'zoom'
  }),
  tpl('react-question', 'はてな', 'reaction', '状況が飲み込めない', '!?', 2, {
    position: 'center',
    customPosition: { x: 0.76, y: 0.3 },
    fontFamily: 'Dela Gothic One',
    fontSize: 120,
    color: '#ffffff',
    outlineColor: '#6a1b9a',
    outlineWidth: 8,
    rotation: 8,
    animation: 'popIn',
    loopAnimation: 'swing'
  }),
  tpl('react-sparkle', 'キラーン', 'reaction', 'ドヤ顔・決めポーズ', 'キラーン', 2, {
    position: 'center',
    customPosition: { x: 0.72, y: 0.3 },
    fontWeight: 900,
    fontSize: 80,
    color: '#ffffff',
    fillGradient: SILVER,
    outlineColor: '#37474f',
    outlineWidth: 5,
    glow: { color: '#ffffff', size: 18, opacity: 0.8 },
    animation: 'none',
    charAnimation: 'pop'
  }),
  tpl('react-cold', 'サムい', 'reaction', 'すべった・寒い空気', 'サムっ…', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 70,
    color: '#e1f5fe',
    outlineColor: '#81d4fa',
    outlineWidth: 5,
    extraStrokes: [{ color: '#01579b', width: 3 }],
    animation: 'fadeIn',
    loopAnimation: 'shake'
  }),
  tpl('react-sweat', 'アセアセ', 'reaction', '焦り・ごまかし', 'アセアセ', 2, {
    position: 'center',
    customPosition: { x: 0.78, y: 0.34 },
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 56,
    color: '#bbdefb',
    outlineColor: '#0d47a1',
    outlineWidth: 5,
    rotation: -6,
    loopAnimation: 'shake'
  }),
  tpl('react-heart', 'キュン', 'reaction', 'かわいい・ときめき', 'キュン', 2, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.32 },
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 76,
    color: '#ff4f9a',
    outlineColor: '#ffffff',
    outlineWidth: 7,
    extraStrokes: [{ color: '#ff4f9a', width: 3 }],
    animation: 'none',
    charAnimation: 'pop',
    loopAnimation: 'pulse'
  }),
  tpl('react-point', 'ここポイント', 'reaction', '見てほしい所を指す', 'ここがポイント', 3, {
    position: 'center',
    customPosition: { x: 0.64, y: 0.36 },
    fontFamily: 'Klee One',
    fontWeight: 600,
    fontSize: 54,
    color: '#ffeb3b',
    outlineColor: '#000000',
    outlineWidth: 5,
    rotation: -4,
    pointer: { dx: -0.12, dy: 0.12, color: '#ffeb3b', width: 6, hand: true },
    animation: 'popIn'
  }),
  tpl(
    'react-calm',
    '冷静なツッコミ',
    'reaction',
    '淡々とした一言(明朝)',
    'いや、普通に無理です',
    2.5,
    {
      position: 'center',
      fontFamily: 'Shippori Mincho',
      fontWeight: 700,
      fontSize: 60,
      outlineColor: '#000000',
      outlineWidth: 5,
      animation: 'fadeIn'
    }
  ),

  // ---------------------------------------------------------------- 擬音
  tpl('sfx-don', 'ドーン', 'sfx', '衝撃・登場', 'ドーン!', 2, {
    position: 'center',
    customPosition: { x: 0.72, y: 0.3 },
    fontFamily: 'Dela Gothic One',
    fontSize: 124,
    color: '#ffd400',
    outlineColor: '#000000',
    outlineWidth: 8,
    rotation: -6,
    animation: 'popIn'
  }),
  tpl('sfx-shin', 'シーン…', 'sfx', '静まり返った空気', 'シーン…', 3, {
    position: 'center',
    fontFamily: 'Klee One',
    fontWeight: 600,
    fontSize: 72,
    color: '#eceff1',
    outlineColor: '#263238',
    outlineWidth: 3,
    letterSpacing: 18,
    shadow: true,
    shadowBlur: 10,
    shadowDistance: 3,
    shadowOpacity: 0.7,
    animation: 'fadeIn'
  }),
  tpl('sfx-gaan', 'ガーン(縦)', 'sfx', 'ショック', 'ガーン', 2.5, {
    vertical: true,
    customPosition: { x: 0.82, y: 0.42 },
    fontWeight: 900,
    fontSize: 104,
    color: '#5c6bc0',
    fillGradient: grad(0, '#9fa8da', '#283593'),
    outlineColor: '#ffffff',
    outlineWidth: 7,
    animation: 'none',
    charAnimation: 'drop'
  }),
  tpl('sfx-gogo', 'ゴゴゴ', 'sfx', '迫力・張りつめた空気', 'ゴゴゴゴ', 3, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.3 },
    fontFamily: 'RocknRoll One',
    fontSize: 96,
    color: '#7b1fa2',
    fillGradient: grad(0, '#ce93d8', '#4a148c'),
    outlineColor: '#000000',
    outlineWidth: 6,
    loopAnimation: 'shake'
  }),
  tpl('sfx-doki', 'ドキドキ', 'sfx', '緊張・期待', 'ドキドキ', 3, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.3 },
    fontFamily: 'RocknRoll One',
    fontSize: 78,
    color: '#ff5c8a',
    outlineColor: '#ffffff',
    outlineWidth: 6,
    animation: 'none',
    charAnimation: 'pop',
    loopAnimation: 'pulse'
  }),
  tpl('sfx-pon', 'ポンッ', 'sfx', '軽い効果・ひらめき', 'ポンッ', 1.5, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.3 },
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 82,
    color: '#ffffff',
    outlineColor: '#00897b',
    outlineWidth: 7,
    animation: 'bounce'
  }),
  tpl('sfx-zawa', 'ざわ…', 'sfx', '不穏・ざわつき', 'ざわ… ざわ…', 3, {
    position: 'center',
    customPosition: { x: 0.7, y: 0.3 },
    fontFamily: 'Yomogi',
    fontSize: 80,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 6,
    rotation: -10,
    loopAnimation: 'shake'
  }),
  tpl('sfx-pikin', 'ピキーン', 'sfx', 'ひらめき・気づき', 'ピキーン', 2, {
    position: 'center',
    customPosition: { x: 0.72, y: 0.3 },
    fontWeight: 900,
    fontSize: 96,
    color: '#ffee58',
    fillGradient: grad(0, '#ffffff', '#ffee58'),
    outlineColor: '#e65100',
    outlineWidth: 7,
    glow: { color: '#ffd600', size: 20, opacity: 0.8 },
    animation: 'none',
    charAnimation: 'zoom'
  }),
  tpl('sfx-gata', 'ガタッ', 'sfx', '思わず立ち上がる・物音', 'ガタッ', 1.5, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.32 },
    fontFamily: 'RocknRoll One',
    fontSize: 92,
    color: '#ffffff',
    outlineColor: '#263238',
    outlineWidth: 7,
    rotation: 8,
    animation: 'popIn'
  }),
  tpl('sfx-kira', 'キラキラ', 'sfx', '輝く・おいしそう', 'キラキラ', 2.5, {
    position: 'center',
    customPosition: { x: 0.72, y: 0.3 },
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 70,
    color: '#fff59d',
    fillGradient: GOLD,
    outlineColor: '#8d5a00',
    outlineWidth: 4,
    extraStrokes: [{ color: '#ffffff', width: 3 }],
    glow: { color: '#ffeb3b', size: 18, opacity: 0.75 },
    loopAnimation: 'wave'
  }),

  // ---------------------------------------------------------------- 感情
  tpl('emo-joy', '喜び', 'emotion', 'うれしい・やった', 'やったー!', 2, {
    position: 'center',
    fontFamily: 'RocknRoll One',
    fontSize: 76,
    color: '#fff59d',
    outlineColor: '#f57f17',
    outlineWidth: 7,
    animation: 'bounce'
  }),
  tpl('emo-fear', '恐怖', 'emotion', 'こわい・ホラーの場面', 'ひっ…', 2.5, {
    position: 'center',
    customPosition: { x: 0.5, y: 0.4 },
    fontFamily: 'Shippori Mincho',
    fontWeight: 800,
    fontSize: 92,
    color: '#e1bee7',
    fillGradient: grad(0, '#ffffff', '#e1bee7', '#b388ff'),
    outlineColor: '#1a0033',
    outlineWidth: 7,
    glow: { color: '#7c4dff', size: 26, opacity: 0.7 },
    animation: 'fadeIn',
    loopAnimation: 'wave'
  }),
  tpl('emo-moved', '感動', 'emotion', '心を動かされた・泣ける', '(感動…)', 3, {
    position: 'center',
    customPosition: { x: 0.5, y: 0.62 },
    fontFamily: 'Zen Maru Gothic',
    fontWeight: 700,
    fontSize: 60,
    color: '#ffffff',
    outlineColor: '#4fc3f7',
    outlineWidth: 5,
    glow: { color: '#b3e5fc', size: 20, opacity: 0.6 },
    animation: 'fadeIn',
    loopAnimation: 'float'
  }),
  tpl('emo-despair', '絶望', 'emotion', 'もうだめだ・心が折れた', '絶望', 3, {
    position: 'center',
    fontWeight: 900,
    fontSize: 110,
    color: '#cfd8dc',
    fillGradient: grad(0, '#eceff1', '#78909c', '#263238'),
    outlineColor: '#000000',
    outlineWidth: 7,
    vertical: true,
    animation: 'none',
    charAnimation: 'drop'
  }),
  tpl('emo-sad', 'しょんぼり', 'emotion', '悲しい・がっかり', '(しょんぼり…)', 3, {
    position: 'center',
    customPosition: { x: 0.5, y: 0.62 },
    fontWeight: 700,
    fontSize: 56,
    color: '#bbdefb',
    outlineColor: '#0d47a1',
    outlineWidth: 5,
    opacity: 0.92,
    animation: 'fadeIn',
    loopAnimation: 'float'
  }),
  tpl('emo-angry', '怒り', 'emotion', 'ムカッ・イラッ', 'ムカッ', 2, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.3 },
    fontWeight: 900,
    fontSize: 88,
    color: '#ffffff',
    outlineColor: '#b71c1c',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ff5252', width: 4 }],
    animation: 'popIn',
    loopAnimation: 'shake'
  }),
  tpl('emo-shy', '照れ', 'emotion', '照れ・はにかみ', '(照)', 2, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.32 },
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 64,
    color: '#ffcdd2',
    outlineColor: '#ad1457',
    outlineWidth: 5,
    loopAnimation: 'swing'
  }),
  tpl('emo-confused', '困惑', 'emotion', '戸惑い・理解できない', '…え?', 2, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.32 },
    fontFamily: 'Yomogi',
    fontSize: 70,
    color: '#ffffff',
    outlineColor: '#4e342e',
    outlineWidth: 5,
    rotation: 6,
    animation: 'fadeIn'
  }),
  tpl('emo-relief', '安堵', 'emotion', 'ホッとする', 'ホッ…', 2.5, {
    position: 'center',
    customPosition: { x: 0.74, y: 0.32 },
    fontFamily: 'Zen Maru Gothic',
    fontWeight: 700,
    fontSize: 66,
    color: '#c8e6c9',
    outlineColor: '#1b5e20',
    outlineWidth: 5,
    animation: 'fadeIn'
  }),
  tpl('emo-tired', 'ぐったり', 'emotion', '疲れ・限界', 'ぐったり…', 3, {
    position: 'center',
    customPosition: { x: 0.5, y: 0.62 },
    fontFamily: 'Klee One',
    fontWeight: 600,
    fontSize: 60,
    color: '#d7ccc8',
    outlineColor: '#3e2723',
    outlineWidth: 5,
    rotation: 4,
    loopAnimation: 'float'
  }),

  // ---------------------------------------------------------------- 情報
  tpl('info-address', '住所', 'info', '店・場所の住所', '住所\n岩手県宮古市日立浜町', 4, {
    customPosition: TOP_LEFT,
    position: 'top',
    fontWeight: 700,
    fontSize: 32,
    outline: false,
    align: 'left',
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.62,
    backgroundRadius: 6,
    backgroundPadding: { x: 20, y: 10 },
    firstLine: { scale: 0.72, color: '#ffd54a' },
    animation: 'fadeIn'
  }),
  tpl(
    'info-hours',
    '営業時間',
    'info',
    '店の営業時間・定休日',
    '営業時間\n11:00〜15:00(水曜定休)',
    4,
    {
      customPosition: TOP_LEFT,
      position: 'top',
      fontWeight: 700,
      fontSize: 32,
      outline: false,
      align: 'left',
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#000000',
      backgroundOpacity: 0.62,
      backgroundRadius: 6,
      backgroundPadding: { x: 20, y: 10 },
      firstLine: { scale: 0.72, color: '#ffd54a' },
      animation: 'fadeIn'
    }
  ),
  tpl('info-tel', '電話番号', 'info', '問い合わせ先', 'TEL 0193-00-0000', 4, {
    customPosition: TOP_LEFT,
    position: 'top',
    fontWeight: 700,
    fontSize: 32,
    outline: false,
    letterSpacing: 1,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.62,
    backgroundRadius: 6,
    backgroundPadding: { x: 20, y: 8 },
    animation: 'fadeIn'
  }),
  tpl(
    'info-menu',
    'お品書き',
    'info',
    'メニューと値段の札',
    'お品書き\nうに丼 **2,800円**\nいくら丼 **2,200円**',
    5,
    {
      customPosition: TOP_RIGHT,
      position: 'top',
      fontFamily: 'Shippori Mincho',
      fontWeight: 700,
      fontSize: 36,
      color: '#3e2723',
      outline: false,
      align: 'left',
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#fffaf0',
      backgroundOpacity: 0.97,
      backgroundRadius: 6,
      backgroundBorder: { color: '#5d4037', width: 3 },
      backgroundPadding: { x: 26, y: 14 },
      firstLine: { scale: 0.8, color: '#b71c1c' },
      accent: { color: '#b71c1c' },
      animation: 'slideInDown'
    }
  ),
  tpl('info-data', 'データ(数字大)', 'info', '数字を大きく見せる', 'およそ **1万2千** 人', 3, {
    position: 'top',
    fontWeight: 800,
    fontSize: 40,
    outlineColor: '#000000',
    outlineWidth: 5,
    accent: { scale: 2, color: '#ffe14d' },
    animation: 'popIn'
  }),
  tpl(
    'info-compare',
    '比較',
    'info',
    '2つを並べて比べる',
    'A店 **1,200円**  vs  B店 **980円**',
    4,
    {
      position: 'top',
      fontWeight: 700,
      fontSize: 42,
      outline: false,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#263238',
      backgroundOpacity: 0.92,
      backgroundRadius: 10,
      backgroundPadding: { x: 28, y: 12 },
      accent: { color: '#ffd54a', scale: 1.2 },
      animation: 'slideInDown'
    }
  ),
  tpl(
    'info-warning',
    '注意書き',
    'info',
    'マネしないで・危険の注意',
    '危険ですので絶対にマネしないでください',
    4,
    {
      customPosition: { x: 0.5, y: 0.9 },
      fontWeight: 700,
      fontSize: 30,
      color: '#111111',
      outline: false,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#ffd600',
      backgroundOpacity: 1,
      backgroundRadius: 4,
      backgroundBorder: { color: '#111111', width: 3 },
      backgroundPadding: { x: 20, y: 8 }
    }
  ),
  tpl('info-rank', '順位', 'info', 'ランキングの順位と名前', '**第1位**\nうに丼', 3.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 56,
    outlineColor: '#3e2723',
    outlineWidth: 6,
    accent: { scale: 1.6, gradient: GOLD },
    animation: 'popIn'
  }),
  tpl('info-weather', '天気・気温', 'info', '撮影時の天気', '晴れ 28℃', 3, {
    customPosition: TOP_RIGHT,
    position: 'top',
    fontWeight: 700,
    fontSize: 34,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#0288d1',
    backgroundGradient: grad(0, '#29b6f6', '#0277bd'),
    backgroundOpacity: 0.95,
    backgroundRadius: 28,
    backgroundPadding: { x: 26, y: 6 },
    animation: 'fadeIn'
  }),
  tpl(
    'info-distance',
    '残りの距離',
    'info',
    '目的地までの距離・時間',
    '目的地まで **あと3km**',
    3,
    {
      customPosition: TOP_LEFT,
      position: 'top',
      fontWeight: 700,
      fontSize: 36,
      outline: false,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#000000',
      backgroundOpacity: 0.62,
      backgroundRadius: 30,
      backgroundPadding: { x: 26, y: 8 },
      accent: { color: '#ffe14d', scale: 1.2 }
    }
  ),
  tpl('info-date', 'ロケ日', 'info', '撮影した日付', 'ロケ日 2024.5.1(水)', 3, {
    customPosition: TOP_LEFT,
    position: 'top',
    fontWeight: 500,
    fontSize: 30,
    outline: false,
    letterSpacing: 2,
    background: true,
    backgroundColor: '#000000',
    backgroundOpacity: 0.5,
    animation: 'fadeIn'
  }),
  tpl('info-source', '出典', 'info', '引用した資料・写真の出典', '出典:宮古市観光協会', 4, {
    customPosition: { x: 0.84, y: 0.95 },
    fontWeight: 500,
    fontSize: 24,
    outlineColor: '#000000',
    outlineWidth: 3,
    opacity: 0.92
  }),
  tpl('info-population', '人口・規模', 'info', '町の人口などの数字', '人口 **約5万人**', 3, {
    position: 'top',
    fontWeight: 800,
    fontSize: 40,
    outlineColor: '#002f4b',
    outlineWidth: 5,
    accent: { scale: 1.6, color: '#4fc3f7' },
    animation: 'popIn'
  }),
  tpl('info-caption', '写真説明', 'info', '画の内容の説明', '昭和30年ごろの港のようす', 3.5, {
    customPosition: { x: 0.5, y: 0.84 },
    fontFamily: 'Noto Serif JP',
    fontWeight: 700,
    fontSize: 32,
    outline: false,
    background: true,
    backgroundColor: '#000000',
    backgroundOpacity: 0.55,
    animation: 'fadeIn'
  }),
  tpl(
    'info-recipe',
    '材料・手順',
    'info',
    '料理の材料や手順を箇条書きで',
    '材料(2人分)\n・うに 100g\n・ご飯 2杯',
    5,
    {
      customPosition: TOP_RIGHT,
      position: 'top',
      fontFamily: 'M PLUS Rounded 1c',
      fontWeight: 700,
      fontSize: 32,
      color: '#3e2723',
      outline: false,
      align: 'left',
      lineHeight: 1.35,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#fff8e1',
      backgroundOpacity: 0.96,
      backgroundRadius: 14,
      backgroundPadding: { x: 26, y: 14 },
      firstLine: { color: '#e65100' },
      animation: 'slideInDown'
    }
  ),

  // ---------------------------------------------------------------- 人物
  tpl(
    'people-title',
    '名前と肩書き',
    'people',
    '名前の上に肩書きを小さく',
    '漁師歴40年\n山田 太郎',
    4,
    {
      customPosition: LOWER_LEFT,
      fontWeight: 800,
      fontSize: 46,
      color: '#1a1a1a',
      outline: false,
      align: 'left',
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#ffffff',
      backgroundOpacity: 0.95,
      backgroundRadius: 4,
      backgroundPadding: { x: 24, y: 10 },
      firstLine: { scale: 0.55, color: '#c62828' },
      animation: 'slideInUp'
    }
  ),
  tpl('people-band', '名前(色帯)', 'people', '斜めの色帯の名前', '山田 太郎', 3.5, {
    customPosition: LOWER_LEFT,
    fontWeight: 800,
    fontSize: 46,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#c2185b',
    backgroundGradient: grad(90, '#e91e63', '#880e4f'),
    backgroundOpacity: 0.96,
    backgroundSkew: -10,
    backgroundPadding: { x: 34, y: 8 },
    animation: 'slideInUp'
  }),
  tpl(
    'people-streamer',
    '実況者の名前',
    'people',
    '実況者・配信者の名前を左上に出し続ける',
    '実況 **たろう**',
    10,
    {
      customPosition: { x: 0.12, y: 0.07 },
      position: 'top',
      fontWeight: 800,
      fontSize: 30,
      color: '#ffffff',
      outline: false,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#000000',
      backgroundOpacity: 0.55,
      backgroundRadius: 30,
      backgroundPadding: { x: 20, y: 4 },
      accent: { scale: 1.2, color: '#80d8ff' }
    }
  ),
  tpl(
    'people-collab',
    'コラボ参加者',
    'people',
    'コラボの参加者を色分けで紹介',
    '**たろう** × **はなこ** × **じろう**',
    4,
    {
      customPosition: { x: 0.5, y: 0.2 },
      position: 'top',
      fontWeight: 900,
      fontSize: 44,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 6,
      accent: { scale: 1.15, color: '#ffeb3b' },
      animation: 'none',
      charAnimation: 'pop'
    }
  ),
  tpl(
    'people-age',
    '名前(年齢・出身)',
    'people',
    '名前に年齢と出身を添える',
    '山田 太郎さん __(68) 宮古市出身__',
    3.5,
    {
      customPosition: LOWER_LEFT,
      fontWeight: 800,
      fontSize: 44,
      outlineColor: '#000000',
      outlineWidth: 6,
      sub: { scale: 0.68, color: '#ffe082' },
      animation: 'slideInUp'
    }
  ),
  tpl('people-expert', '専門家', 'people', '解説する専門家の紹介', '海洋学者\n佐藤 花子 教授', 4, {
    customPosition: LOWER_LEFT,
    fontWeight: 800,
    fontSize: 44,
    outline: false,
    align: 'left',
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#0d47a1',
    backgroundGradient: grad(90, '#1565c0', '#0a2f6b'),
    backgroundOpacity: 0.95,
    backgroundRadius: 4,
    backgroundPadding: { x: 24, y: 10 },
    firstLine: { scale: 0.6, color: '#bbdefb' },
    animation: 'slideInUp'
  }),
  tpl('people-kid', '子ども', 'people', '子どもの名前(やわらかく)', 'はるとくん(5さい)', 3, {
    customPosition: LOWER_LEFT,
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 46,
    color: '#ff7043',
    outlineColor: '#ffffff',
    outlineWidth: 6,
    extraStrokes: [{ color: '#ff7043', width: 2 }],
    animation: 'bounce'
  }),
  tpl(
    'people-guest',
    'ゲスト紹介',
    'people',
    'スペシャルゲストを大きく',
    'スペシャルゲスト\n鈴木 一郎さん',
    3.5,
    {
      position: 'center',
      fontWeight: 900,
      fontSize: 84,
      color: '#ffd54f',
      fillGradient: GOLD,
      outlineColor: '#000000',
      outlineWidth: 7,
      firstLine: { scale: 0.42, color: '#ffffff' },
      animation: 'none',
      charAnimation: 'zoom'
    }
  ),
  tpl('people-team', 'チーム名', 'people', 'チーム・グループの名前', 'チームA', 3, {
    customPosition: TOP_LEFT,
    position: 'top',
    fontWeight: 900,
    fontSize: 40,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#43a047',
    backgroundOpacity: 0.96,
    backgroundRadius: 40,
    backgroundPadding: { x: 30, y: 6 },
    animation: 'popIn'
  }),

  // ---------------------------------------------------------------- 番組構成
  tpl(
    'struct-opening',
    'オープニングタイトル',
    'structure',
    '番組・企画のタイトル',
    '日本縦断ロケ\n島の水を探せ!',
    4,
    {
      position: 'center',
      fontWeight: 900,
      fontSize: 104,
      color: '#ffffff',
      fillGradient: grad(0, '#ffffff', '#ffe082'),
      outlineColor: '#b71c1c',
      outlineWidth: 8,
      extraStrokes: [{ color: '#ffffff', width: 5 }],
      shadow: true,
      shadowBlur: 16,
      shadowDistance: 8,
      shadowOpacity: 0.5,
      firstLine: { scale: 0.38, color: '#ffffff' },
      animation: 'none',
      charAnimation: 'pop'
    }
  ),
  tpl('struct-cm', 'CM前のあおり', 'structure', 'CMをまたぐ引き', 'この後\n衝撃の結末が…', 3, {
    position: 'center',
    fontWeight: 900,
    fontSize: 70,
    color: '#ffeb3b',
    outlineColor: '#000000',
    outlineWidth: 5,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.82,
    backgroundPadding: { x: 48, y: 16 },
    firstLine: { scale: 0.5, color: '#ffffff' },
    animation: 'fadeIn'
  }),
  tpl('struct-continue', 'つづき', 'structure', 'CM明け・後半の始まり', 'つづき', 2.5, {
    position: 'top',
    fontWeight: 800,
    fontSize: 40,
    outline: false,
    letterSpacing: 6,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#c62828',
    backgroundOpacity: 0.92,
    backgroundPadding: { x: 30, y: 6 },
    animation: 'slideInDown'
  }),
  tpl('struct-next', '次回予告', 'structure', '次回の予告', '次回\n最終回スペシャル', 4, {
    position: 'center',
    fontWeight: 900,
    fontSize: 92,
    outlineColor: '#0d47a1',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    firstLine: { scale: 0.45, color: '#ffeb3b' },
    animation: 'popIn'
  }),
  tpl('struct-ending', 'おわり', 'structure', 'エンディング', '— おわり —', 4, {
    position: 'center',
    fontFamily: 'Shippori Mincho',
    fontWeight: 700,
    fontSize: 56,
    // 細い縁(明るい画の上でも読める)
    outlineColor: '#1a1a1a',
    outlineWidth: 3,
    letterSpacing: 10,
    shadow: true,
    shadowBlur: 8,
    shadowDistance: 2,
    shadowOpacity: 0.8,
    animation: 'fadeIn',
    exitAnimation: 'fadeOut'
  }),
  tpl(
    'struct-sponsor',
    '提供',
    'structure',
    '提供の読み上げ',
    'この番組は ご覧のスポンサーの提供でお送りしました',
    5,
    {
      position: 'center',
      fontFamily: 'Shippori Mincho',
      fontWeight: 700,
      fontSize: 40,
      // 細い縁(明るい画の上でも読める)
      outlineColor: '#1a1a1a',
      outlineWidth: 3,
      letterSpacing: 4,
      shadow: true,
      shadowBlur: 6,
      shadowDistance: 2,
      shadowOpacity: 0.8,
      animation: 'fadeIn',
      exitAnimation: 'fadeOut'
    }
  ),
  tpl('struct-flashback', '回想', 'structure', '過去の場面に入る', '〜回想〜', 3, {
    position: 'top',
    fontFamily: 'Shippori Mincho',
    fontWeight: 700,
    fontSize: 54,
    color: '#f3e5ab',
    outlineColor: '#3e2723',
    outlineWidth: 4,
    letterSpacing: 6,
    animation: 'fadeIn',
    exitAnimation: 'fadeOut'
  }),
  tpl('struct-later', '時間経過', 'structure', '時間が飛んだことを示す', '— 3時間後 —', 3, {
    position: 'center',
    fontWeight: 700,
    fontSize: 56,
    outline: false,
    letterSpacing: 4,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.72,
    backgroundPadding: { x: 40, y: 12 },
    animation: 'fadeIn',
    exitAnimation: 'fadeOut'
  }),
  tpl('struct-meanwhile', '一方そのころ', 'structure', '別の場所に切り替える', '一方そのころ…', 3, {
    customPosition: { x: 0.24, y: 0.12 },
    position: 'top',
    fontWeight: 900,
    fontSize: 54,
    outlineColor: '#000000',
    outlineWidth: 6,
    animation: 'slideInDown'
  }),
  tpl('struct-reenact', '再現VTR', 'structure', '再現映像であることの表示', '再現VTR', 6, {
    customPosition: { x: 0.9, y: 0.07 },
    position: 'top',
    fontWeight: 700,
    fontSize: 28,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.6,
    backgroundRadius: 4,
    backgroundPadding: { x: 14, y: 4 }
  }),
  tpl('struct-image', '※イメージ', 'structure', 'イメージ映像の表示', '※イメージ', 6, {
    customPosition: { x: 0.9, y: 0.93 },
    fontWeight: 700,
    fontSize: 28,
    outlineColor: '#000000',
    outlineWidth: 3
  }),
  tpl('struct-staged', '※演出です', 'structure', '演出であることの表示', '※演出です', 4, {
    customPosition: { x: 0.9, y: 0.93 },
    fontWeight: 700,
    fontSize: 26,
    outlineColor: '#000000',
    outlineWidth: 3
  }),
  tpl('struct-highlight', '名場面', 'structure', '名場面・振り返り', '名場面', 3, {
    position: 'center',
    customPosition: { x: 0.5, y: 0.2 },
    fontWeight: 900,
    fontSize: 76,
    color: '#ffd54f',
    fillGradient: GOLD,
    outlineColor: '#000000',
    outlineWidth: 6,
    glow: { color: '#ffd54f', size: 20, opacity: 0.6 },
    animation: 'none',
    charAnimation: 'zoom'
  }),
  tpl('struct-digest', 'ダイジェスト', 'structure', 'まとめ映像の表示', 'ダイジェスト', 4, {
    customPosition: { x: 0.16, y: 0.1 },
    position: 'top',
    fontWeight: 900,
    fontSize: 38,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#d50000',
    backgroundOpacity: 0.95,
    backgroundSkew: -10,
    backgroundPadding: { x: 28, y: 6 },
    animation: 'slideInDown'
  }),
  tpl('struct-live', 'LIVE', 'structure', '生配信・生中継の表示', 'LIVE', 10, {
    customPosition: { x: 0.07, y: 0.07 },
    position: 'top',
    fontWeight: 900,
    fontSize: 30,
    outline: false,
    letterSpacing: 2,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#e53935',
    backgroundOpacity: 1,
    backgroundRadius: 6,
    backgroundPadding: { x: 16, y: 4 },
    loopAnimation: 'pulse'
  }),
  tpl('struct-part', 'その壱(縦)', 'structure', '章の番号を縦書きで', 'その壱', 3, {
    vertical: true,
    customPosition: { x: 0.12, y: 0.42 },
    fontFamily: 'Shippori Mincho',
    fontWeight: 700,
    fontSize: 84,
    outlineColor: '#000000',
    outlineWidth: 5,
    letterSpacing: 8,
    animation: 'fadeIn'
  }),
  tpl(
    'struct-subtitle',
    '企画のサブタイトル',
    'structure',
    'タイトルの下に添える説明',
    '〜絶品グルメを探して〜',
    4,
    {
      position: 'center',
      customPosition: { x: 0.5, y: 0.64 },
      fontFamily: 'Noto Serif JP',
      fontWeight: 700,
      fontSize: 46,
      outlineColor: '#000000',
      outlineWidth: 5,
      animation: 'fadeIn'
    }
  ),

  // ---------------------------------------------------------------- クイズ・ゲーム
  tpl('game-correct', '正解', 'game', '正解の発表', '〇 正解!', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 120,
    color: '#ff5252',
    fillGradient: grad(0, '#ff8a80', '#d50000'),
    outlineColor: '#ffffff',
    outlineWidth: 8,
    extraStrokes: [{ color: '#b71c1c', width: 4 }],
    animation: 'none',
    charAnimation: 'zoom'
  }),
  tpl('game-wrong', '不正解', 'game', '不正解の発表', '× 不正解', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 120,
    color: '#448aff',
    fillGradient: grad(0, '#82b1ff', '#2962ff'),
    outlineColor: '#ffffff',
    outlineWidth: 8,
    extraStrokes: [{ color: '#0d47a1', width: 4 }],
    animation: 'popIn',
    loopAnimation: 'shake'
  }),
  tpl('game-choice', '選択肢', 'game', 'クイズの選択肢', 'A 宮古島\nB 石垣島\nC 奄美大島', 6, {
    customPosition: { x: 0.78, y: 0.45 },
    fontWeight: 800,
    fontSize: 42,
    outline: false,
    align: 'left',
    lineHeight: 1.45,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#283593',
    backgroundGradient: grad(0, '#3949ab', '#1a237e'),
    backgroundOpacity: 0.94,
    backgroundRadius: 12,
    backgroundBorder: { color: '#ffffff', width: 3 },
    backgroundPadding: { x: 30, y: 16 },
    animation: 'slideInDown'
  }),
  tpl('game-score', '得点', 'game', '得点を出し続ける', '得点 **120**', 10, {
    customPosition: TOP_RIGHT,
    position: 'top',
    fontWeight: 800,
    fontSize: 34,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.65,
    backgroundRadius: 40,
    backgroundPadding: { x: 28, y: 4 },
    accent: { scale: 1.6, color: '#ffeb3b' }
  }),
  tpl('game-timer', '残り時間', 'game', '制限時間を出し続ける', '残り **0:30**', 10, {
    customPosition: TOP_RIGHT,
    position: 'top',
    fontWeight: 800,
    fontSize: 34,
    outlineColor: '#000000',
    outlineWidth: 5,
    accent: { scale: 1.7, color: '#ff5252' },
    loopAnimation: 'pulse'
  }),
  tpl('game-rule', 'ルール', 'game', '企画のルール説明', 'ルール\n3分以内に名物を3つ見つける', 6, {
    position: 'center',
    fontWeight: 700,
    fontSize: 40,
    outline: false,
    align: 'left',
    lineHeight: 1.4,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#1b2a4a',
    backgroundOpacity: 0.93,
    backgroundRadius: 12,
    backgroundBorder: { color: '#ffffff', width: 2 },
    backgroundPadding: { x: 34, y: 18 },
    firstLine: { scale: 1.2, color: '#ffd54a' },
    animation: 'fadeIn'
  }),
  tpl('game-mission', 'ミッション', 'game', '課題の発表', 'MISSION\n絶景スポットを探せ', 4, {
    position: 'top',
    fontWeight: 900,
    fontSize: 60,
    outlineColor: '#000000',
    outlineWidth: 6,
    firstLine: { scale: 0.62, color: '#ff5252' },
    animation: 'slideInDown'
  }),
  tpl('game-punish', '罰ゲーム', 'game', '罰ゲームの決定', '罰ゲーム決定!', 3, {
    position: 'center',
    fontWeight: 900,
    fontSize: 84,
    color: '#ffffff',
    outlineColor: '#6a1b9a',
    outlineWidth: 6,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    animation: 'popIn',
    loopAnimation: 'shake'
  }),
  tpl('game-winner', '優勝', 'game', '勝者の発表', '優勝!!', 3, {
    position: 'center',
    fontWeight: 900,
    fontSize: 130,
    color: '#ffd54f',
    fillGradient: GOLD,
    outlineColor: '#4e2600',
    outlineWidth: 8,
    glow: { color: '#ffd54a', size: 26, opacity: 0.7 },
    animation: 'none',
    charAnimation: 'zoom'
  }),
  tpl('game-vs', 'VS', 'game', '対決の構図', 'VS', 3, {
    position: 'center',
    fontFamily: 'Dela Gothic One',
    fontSize: 140,
    color: '#ffffff',
    fillGradient: grad(90, '#ff5252', '#448aff'),
    outlineColor: '#ffffff',
    outlineWidth: 8,
    extraStrokes: [{ color: '#000000', width: 4 }],
    rotation: -6,
    italic: true,
    animation: 'popIn'
  }),
  tpl('game-round', 'ラウンド', 'game', '回戦・ラウンドの区切り', 'ROUND 1', 2.5, {
    customPosition: { x: 0.2, y: 0.12 },
    position: 'top',
    fontWeight: 900,
    fontSize: 54,
    italic: true,
    outlineColor: '#000000',
    outlineWidth: 6,
    fillGradient: SILVER,
    animation: 'slideInDown'
  }),
  tpl('game-count', 'カウントダウン', 'game', '3・2・1 の数字', '3', 1, {
    position: 'center',
    fontWeight: 900,
    fontSize: 220,
    outlineColor: '#000000',
    outlineWidth: 12,
    animation: 'none',
    charAnimation: 'zoom',
    exitAnimation: 'zoomOut'
  }),
  tpl('game-hint', 'ヒント', 'game', 'クイズのヒント', 'ヒント:名物は海のもの', 4, {
    position: 'top',
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 40,
    color: '#1a1a1a',
    outline: false,
    background: true,
    backgroundShape: 'bubble',
    backgroundColor: '#fff59d',
    backgroundOpacity: 1,
    backgroundRadius: 30,
    backgroundBorder: { color: '#1a1a1a', width: 3 },
    backgroundPadding: { x: 28, y: 12 },
    bubbleTail: { side: 'bottom', at: 0.2, length: 26 },
    animation: 'popIn'
  }),

  // ---------------------------------------------------------------- ゲーム実況
  // ゲーム画面の HUD(体力・ミニマップ)は四隅と下に多いので、常に出す物は上の中ほど・左上に寄せ、
  // 一瞬の物は画面の真ん中に大きく出す
  tpl('play-scream', '絶叫', 'play', '実況者の叫び・悲鳴を特大で', 'うわあああ!!', 2, {
    position: 'center',
    fontWeight: 900,
    fontSize: 118,
    color: '#ffeb3b',
    fillGradient: grad(0, '#ffffff', '#ffeb3b', '#ff6d00'),
    outlineColor: '#b71c1c',
    outlineWidth: 9,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    rotation: -4,
    animation: 'popIn',
    loopAnimation: 'shake'
  }),
  tpl('play-died', 'やられた', 'play', 'やられた・死んだ瞬間', '死亡', 3, {
    position: 'center',
    fontFamily: 'Shippori Mincho',
    fontWeight: 800,
    fontSize: 110,
    color: '#c62828',
    outline: false,
    letterSpacing: 24,
    shadow: true,
    shadowColor: '#000000',
    shadowOpacity: 0.85,
    shadowDistance: 0,
    shadowBlur: 24,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundGradient: grad(0, '#00000000', '#000000cc', '#00000000'),
    backgroundOpacity: 1,
    backgroundPadding: { x: 500, y: 26 },
    animation: 'fadeIn',
    animationSpeed: 0.5
  }),
  tpl('play-gameover', 'ゲームオーバー', 'play', '全滅・やり直しの場面', 'GAME OVER', 3, {
    position: 'center',
    fontFamily: 'Dela Gothic One',
    fontSize: 104,
    color: '#ff1744',
    outlineColor: '#000000',
    outlineWidth: 8,
    letterSpacing: 6,
    glow: { color: '#ff1744', size: 26, opacity: 0.6 },
    animation: 'none',
    charAnimation: 'drop',
    loopAnimation: 'pulse'
  }),
  tpl('play-clear', 'クリア', 'play', 'ステージ・ボスを突破した瞬間', 'STAGE CLEAR!!', 3, {
    position: 'center',
    fontFamily: 'Dela Gothic One',
    fontSize: 100,
    color: '#ffd54f',
    fillGradient: GOLD,
    outlineColor: '#3e2723',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    glow: { color: '#fff59d', size: 30, opacity: 0.55 },
    animation: 'none',
    charAnimation: 'zoom'
  }),
  tpl('play-boss', 'ボス戦', 'play', 'ボスの登場・ボス戦の始まり', 'BOSS\n**炎の番人**', 3.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 54,
    color: '#ffffff',
    outline: false,
    letterSpacing: 10,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#b71c1c',
    backgroundGradient: grad(90, '#00000000', '#b71c1cee', '#b71c1cee', '#00000000'),
    backgroundOpacity: 1,
    backgroundPadding: { x: 260, y: 18 },
    backgroundSkew: -10,
    accent: { scale: 1.6, color: '#ffeb3b' },
    animation: 'slideInUp',
    exitAnimation: 'fadeOut'
  }),
  tpl('play-defeat', '撃破', 'play', 'ボス・強敵を倒した瞬間', '撃破!', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 120,
    color: '#ffffff',
    fillGradient: grad(0, '#ffffff', '#80d8ff', '#0091ea'),
    outlineColor: '#01579b',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    rotation: -6,
    animation: 'popIn',
    exitAnimation: 'zoomOut'
  }),
  tpl('play-win', '勝利', 'play', '対戦に勝った', 'WIN', 3, {
    position: 'center',
    fontFamily: 'Dela Gothic One',
    fontSize: 140,
    color: '#ffd54f',
    fillGradient: GOLD,
    outlineColor: '#000000',
    outlineWidth: 9,
    letterSpacing: 12,
    glow: { color: '#ffecb3', size: 34, opacity: 0.6 },
    animation: 'none',
    charAnimation: 'pop'
  }),
  tpl('play-lose', '敗北', 'play', '対戦に負けた', 'LOSE...', 3, {
    position: 'center',
    fontFamily: 'Dela Gothic One',
    fontSize: 120,
    color: '#90a4ae',
    fillGradient: SILVER,
    outlineColor: '#263238',
    outlineWidth: 8,
    letterSpacing: 8,
    animation: 'slideInDown',
    loopAnimation: 'float'
  }),
  tpl('play-nice', 'ナイス', 'play', '上手くいった・好プレイ', 'ナイス!!', 2, {
    position: 'center',
    fontFamily: 'RocknRoll One',
    fontSize: 104,
    color: '#76ff03',
    fillGradient: grad(0, '#f4ff81', '#76ff03', '#00c853'),
    outlineColor: '#1b5e20',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 5 }],
    rotation: -5,
    animation: 'popIn'
  }),
  tpl('play-god', '神プレイ', 'play', '奇跡の操作・ありえない好プレイ', '神プレイ', 3, {
    position: 'center',
    fontWeight: 900,
    fontSize: 116,
    color: '#ffffff',
    fillGradient: RAINBOW,
    outlineColor: '#ffffff',
    outlineWidth: 7,
    extraStrokes: [{ color: '#311b92', width: 6 }],
    glow: { color: '#ffffff', size: 30, opacity: 0.6 },
    animation: 'none',
    charAnimation: 'zoom',
    loopAnimation: 'pulse'
  }),
  tpl('play-close', '惜しい', 'play', 'あと少しで届かなかった', '惜しい…!', 2.5, {
    position: 'center',
    fontWeight: 900,
    fontSize: 100,
    color: '#ffab40',
    outlineColor: '#4e342e',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    animation: 'bounce'
  }),
  tpl('play-pinch', 'ピンチ', 'play', '体力が少ない・追い詰められた', 'ピンチ!!', 3, {
    customPosition: { x: 0.5, y: 0.3 },
    fontWeight: 900,
    fontSize: 90,
    color: '#ff1744',
    outlineColor: '#ffffff',
    outlineWidth: 7,
    extraStrokes: [{ color: '#000000', width: 4 }],
    animation: 'popIn',
    loopAnimation: 'blink'
  }),
  tpl('play-lol', '草', 'play', '笑える場面(配信の「草」)', '草www', 2, {
    customPosition: { x: 0.78, y: 0.3 },
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 900,
    fontSize: 84,
    color: '#69f0ae',
    outlineColor: '#1b5e20',
    outlineWidth: 7,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    rotation: 6,
    animation: 'popIn',
    loopAnimation: 'swing'
  }),
  tpl('play-replay', 'リプレイ', 'play', '同じ場面をもう一度・スローで見せる', 'REPLAY', 4, {
    customPosition: { x: 0.12, y: 0.1 },
    position: 'top',
    fontWeight: 900,
    fontSize: 34,
    color: '#ffffff',
    outline: false,
    italic: true,
    letterSpacing: 4,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#d50000',
    backgroundOpacity: 0.95,
    backgroundRadius: 4,
    backgroundPadding: { x: 18, y: 4 },
    backgroundSkew: -12,
    loopAnimation: 'blink'
  }),
  tpl('play-skip', '中略', 'play', '作業・移動・稼ぎを飛ばした所', '(中略)\n__30分後__', 2.5, {
    position: 'center',
    fontWeight: 800,
    fontSize: 60,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 6,
    sub: { scale: 0.6, color: '#b0bec5' },
    animation: 'fadeIn',
    exitAnimation: 'fadeOut'
  }),
  tpl('play-deaths', 'デス数', 'play', 'やられた回数を出し続ける', 'デス **12**', 10, {
    customPosition: { x: 0.5, y: 0.07 },
    position: 'top',
    fontWeight: 800,
    fontSize: 34,
    color: '#ffffff',
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.6,
    backgroundRadius: 40,
    backgroundPadding: { x: 26, y: 4 },
    accent: { scale: 1.5, color: '#ff5252' }
  }),
  tpl(
    'play-progress',
    '進行状況',
    'play',
    '今どこを遊んでいるか(章・ステージ)',
    'CHAPTER 3\n__忘れられた砦__',
    6,
    {
      customPosition: TOP_LEFT,
      position: 'top',
      fontWeight: 900,
      fontSize: 32,
      color: '#ffffff',
      outline: false,
      align: 'left',
      letterSpacing: 3,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#000000',
      backgroundGradient: grad(90, '#000000cc', '#00000000'),
      backgroundOpacity: 1,
      backgroundPadding: { x: 24, y: 8 },
      sub: { scale: 0.8, color: '#ffd54f' },
      animation: 'slideInDown'
    }
  ),
  tpl('play-goal', '今日の目標', 'play', '回の始めに目標を出す', '今日の目標\n**ボスを倒す!**', 5, {
    customPosition: { x: 0.5, y: 0.2 },
    position: 'top',
    fontWeight: 800,
    fontSize: 40,
    color: '#ffffff',
    outline: false,
    lineHeight: 1.3,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#1565c0',
    backgroundGradient: grad(0, '#1e88e5', '#0d47a1'),
    backgroundOpacity: 0.95,
    backgroundRadius: 14,
    backgroundBorder: { color: '#ffffff', width: 3 },
    backgroundPadding: { x: 34, y: 14 },
    accent: { scale: 1.3, color: '#ffeb3b' },
    animation: 'popIn'
  }),
  tpl('play-firsttime', '初見プレイ', 'play', '初めて遊ぶことを出し続ける', '初見プレイ', 10, {
    customPosition: { x: 0.08, y: 0.06 },
    position: 'top',
    fontWeight: 900,
    fontSize: 28,
    color: '#ffffff',
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#ff6d00',
    backgroundOpacity: 1,
    backgroundRadius: 30,
    backgroundPadding: { x: 18, y: 4 }
  }),
  tpl('play-control', '操作説明', 'play', 'ボタン・操作のしかた', '**R1** 攻撃 **〇** 回避', 4, {
    customPosition: { x: 0.5, y: 0.2 },
    position: 'top',
    fontWeight: 700,
    fontSize: 36,
    color: '#ffffff',
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#212121',
    backgroundOpacity: 0.82,
    backgroundRadius: 10,
    backgroundPadding: { x: 26, y: 10 },
    accent: { scale: 1.05, color: '#40c4ff' },
    animation: 'fadeIn'
  }),
  tpl(
    'play-item',
    'アイテム入手',
    'play',
    '物を手に入れた・宝箱を開けた',
    '**伝説の剣**を手に入れた!',
    3,
    {
      customPosition: { x: 0.5, y: 0.2 },
      position: 'top',
      fontWeight: 700,
      fontSize: 38,
      color: '#ffffff',
      outline: false,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#0a1a3c',
      backgroundOpacity: 0.92,
      backgroundRadius: 8,
      backgroundBorder: { color: '#ffffff', width: 4 },
      backgroundPadding: { x: 30, y: 14 },
      accent: { color: '#ffd54f' },
      animation: 'typewriter'
    }
  ),
  tpl('play-window', 'RPGの会話窓', 'play', 'ゲーム風の会話・心の声', 'ゆうしゃは にげだした!', 3, {
    customPosition: { x: 0.5, y: 0.19 },
    position: 'top',
    fontFamily: 'Kosugi Maru',
    fontWeight: 700,
    fontSize: 40,
    color: '#ffffff',
    outline: false,
    align: 'left',
    letterSpacing: 2,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.92,
    backgroundRadius: 6,
    backgroundBorder: { color: '#ffffff', width: 5 },
    backgroundPadding: { x: 40, y: 22 },
    animation: 'typewriter'
  }),
  tpl('play-levelup', 'レベルアップ', 'play', '成長・強くなった', 'LEVEL UP!', 2.5, {
    customPosition: { x: 0.5, y: 0.3 },
    fontFamily: 'Dela Gothic One',
    fontSize: 80,
    color: '#ffeb3b',
    fillGradient: grad(0, '#ffffff', '#ffeb3b', '#ff9100'),
    outlineColor: '#e65100',
    outlineWidth: 6,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    animation: 'slideInUp',
    exitAnimation: 'slideOutUp'
  }),
  tpl(
    'play-achievement',
    '実績解除',
    'play',
    '目標・やり込みを達成した',
    '__実績解除__\n**初めての勝利**',
    4,
    {
      customPosition: TOP_RIGHT,
      position: 'top',
      fontWeight: 800,
      fontSize: 30,
      color: '#ffffff',
      outline: false,
      align: 'left',
      lineHeight: 1.35,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#263238',
      backgroundOpacity: 0.94,
      backgroundRadius: 12,
      backgroundBorder: { color: '#ffd54f', width: 3 },
      backgroundPadding: { x: 24, y: 10 },
      sub: { scale: 0.75, color: '#ffd54f' },
      accent: { scale: 1.1 },
      animation: 'slideInDown',
      exitAnimation: 'slideOutUp'
    }
  ),
  tpl('play-gacha', 'ガチャ結果', 'play', 'ガチャ・抽選の当たり', '**SSR** 確定!!', 3, {
    position: 'center',
    fontWeight: 900,
    fontSize: 96,
    color: '#ffffff',
    outlineColor: '#4a148c',
    outlineWidth: 8,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    accent: { scale: 1.35, gradient: RAINBOW },
    glow: { color: '#ea80fc', size: 30, opacity: 0.55 },
    animation: 'none',
    charAnimation: 'spin'
  }),
  tpl(
    'play-memo',
    '攻略メモ',
    'play',
    'コツ・攻略の情報を補足',
    '攻略メモ\n__盾で受けてから反撃__',
    5,
    {
      customPosition: { x: 0.2, y: 0.32 },
      fontWeight: 800,
      fontSize: 34,
      color: '#3e2723',
      outline: false,
      align: 'left',
      lineHeight: 1.35,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#fff59d',
      backgroundOpacity: 0.96,
      backgroundRadius: 4,
      backgroundPadding: { x: 22, y: 12 },
      rotation: -2,
      firstLine: { color: '#d84315' },
      sub: { scale: 0.85 },
      animation: 'popIn'
    }
  ),
  tpl(
    'play-enemy',
    '敵の名前',
    'play',
    '敵・キャラクターの名前と説明',
    '__第一の刺客__\nスケルトン',
    3.5,
    {
      customPosition: { x: 0.74, y: 0.32 },
      fontFamily: 'Shippori Mincho',
      fontWeight: 800,
      fontSize: 54,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 6,
      align: 'right',
      sub: { scale: 0.5, color: '#ef9a9a' },
      animation: 'fadeIn',
      exitAnimation: 'fadeOut'
    }
  ),
  tpl(
    'play-part',
    'パート番号',
    'play',
    'シリーズの何本目か(回の頭)',
    '__実況プレイ__\nPart **5**',
    4,
    {
      position: 'center',
      fontFamily: 'Dela Gothic One',
      fontSize: 84,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 7,
      sub: { scale: 0.45, color: '#ffd54f' },
      accent: { scale: 1.35, color: '#ff5252' },
      animation: 'none',
      charAnimation: 'rise',
      exitAnimation: 'fadeOut'
    }
  ),
  tpl(
    'play-chat',
    '視聴者のコメント',
    'play',
    '配信のコメントを読み上げた所',
    '__視聴者__ 右の道が近いよ',
    4,
    {
      customPosition: { x: 0.74, y: 0.42 },
      fontWeight: 700,
      fontSize: 32,
      color: '#ffffff',
      outline: false,
      align: 'left',
      background: true,
      backgroundShape: 'bubble',
      backgroundColor: '#37474f',
      backgroundOpacity: 0.9,
      backgroundRadius: 18,
      backgroundPadding: { x: 22, y: 10 },
      bubbleTail: { side: 'bottom', at: 0.2, length: 18 },
      sub: { scale: 0.75, color: '#80cbc4' },
      animation: 'slideInUp'
    }
  ),
  // ---------------------------------------------------------------- SNS・配信
  tpl(
    'social-youtube',
    '白箱字幕',
    'social',
    'YouTube でよく見る白い箱の字幕',
    'これ知ってましたか?',
    2.5,
    {
      fontWeight: 700,
      fontSize: 44,
      color: '#111111',
      outline: false,
      background: true,
      backgroundColor: '#ffffff',
      backgroundOpacity: 0.95,
      backgroundRadius: 6
    }
  ),
  tpl(
    'social-short',
    '縦型ショート字幕',
    'social',
    '縦型動画の真ん中の大きな字幕',
    'これ知ってた?',
    2,
    {
      position: 'center',
      customPosition: { x: 0.5, y: 0.62 },
      fontWeight: 900,
      fontSize: 76,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 9,
      animation: 'none',
      charAnimation: 'pop'
    }
  ),
  tpl(
    'social-hashtag',
    'ハッシュタグ',
    'social',
    'ハッシュタグを並べる',
    '#宮古島 #絶景 #グルメ',
    4,
    {
      customPosition: { x: 0.24, y: 0.9 },
      fontWeight: 700,
      fontSize: 34,
      color: '#4fc3f7',
      outlineColor: '#000000',
      outlineWidth: 4
    }
  ),
  tpl(
    'social-subscribe',
    'チャンネル登録',
    'social',
    '登録・フォローのお願い',
    'チャンネル登録よろしく!',
    3,
    {
      position: 'center',
      customPosition: { x: 0.5, y: 0.82 },
      fontWeight: 900,
      fontSize: 44,
      outline: false,
      background: true,
      backgroundShape: 'block',
      backgroundColor: '#ff0000',
      backgroundOpacity: 1,
      backgroundRadius: 10,
      backgroundPadding: { x: 30, y: 10 },
      shadow: true,
      shadowBlur: 8,
      shadowDistance: 4,
      shadowOpacity: 0.4,
      animation: 'popIn',
      loopAnimation: 'pulse'
    }
  ),
  tpl('social-comment', 'コメント風', 'social', '視聴者のコメントのように', 'wwwww', 2.5, {
    customPosition: { x: 0.74, y: 0.2 },
    fontWeight: 700,
    fontSize: 40,
    outlineColor: '#000000',
    outlineWidth: 4,
    opacity: 0.95
  }),
  tpl('social-box', '黒箱字幕', 'social', '角の丸い黒い箱の字幕', 'ここからが本番です', 2.5, {
    fontWeight: 700,
    fontSize: 42,
    outline: false,
    background: true,
    backgroundShape: 'block',
    backgroundColor: '#000000',
    backgroundOpacity: 0.75,
    backgroundRadius: 12,
    backgroundPadding: { x: 26, y: 10 }
  }),
  tpl('social-pop', 'ポップ字幕', 'social', '明るい配信の字幕', 'えっ、うそでしょ', 2, {
    fontFamily: 'M PLUS Rounded 1c',
    fontWeight: 800,
    fontSize: 56,
    outlineColor: '#ff6f00',
    outlineWidth: 7,
    extraStrokes: [{ color: '#ffffff', width: 4 }],
    animation: 'bounce'
  }),
  tpl(
    'social-karaoke',
    '歌詞(カラオケ)',
    'social',
    '読んだ所から色が変わる字幕',
    'ここから色が変わります',
    3,
    {
      fontWeight: 800,
      fontSize: 50,
      outlineColor: '#000000',
      outlineWidth: 6,
      wordHighlight: true,
      highlightColor: '#4fc3f7'
    }
  )
]
