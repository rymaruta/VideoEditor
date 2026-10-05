import { useState } from 'react'
import type {
  TelopCharAnimation,
  TelopExitAnimation,
  TelopLoopAnimation,
  TelopBubbleTail,
  TelopSpanStyle,
  TelopStroke,
  TextAnimation,
  TextStyle
} from '@shared/types'
import {
  CHAR_ANIMATION_LABEL,
  CHAR_ANIMATIONS,
  EXIT_ANIMATION_LABEL,
  EXIT_ANIMATIONS,
  FONT_FAMILY_OPTIONS,
  LOOP_ANIMATION_LABEL,
  LOOP_ANIMATIONS,
  TEXT_ANIMATION_MS,
  textBoxPaddingPx
} from '@shared/textStyle'
import { TELOP_LINE_HEIGHT_EM, telopFontWeight } from '@shared/telop/render'
import {
  addStroke,
  effectiveFillGradient,
  FONT_WEIGHT_OPTIONS,
  MAX_STROKES,
  moveStroke,
  pointerToward,
  shadowDisplay,
  strokesFromStyle,
  strokesToStyle
} from '../lib/telopAppearance'
import { readableBackground } from '../lib/appearanceEdit'
import { ColorField } from './ColorField'
import { FillField, NumberSlider, Segmented, StyleSection } from './AppearanceControls'
import { AngleDial } from './GradientEditor'
import { FontPicker } from './FontPicker'
import { SectionPresetMenu } from './SectionPresetMenu'

/**
 * テロップの見た目の欄。Premiere のエッセンシャルグラフィックス(アピアランス)と
 * DaVinci の Text+ を手本に、項目ごとに畳める見出しに分けている。
 *
 *   テキスト → 塗り → 縁(何本でも) → 背景 → 影 → 光彩 → 部分の装飾 → 矢印 → 位置・動き
 *
 * テロップ1本の設定と、テロップスタイルの管理の両方で同じ欄を使う
 * (片方にだけ項目が増えて、もう片方で直せない、ということが起きないように)。
 */

const ANIMATIONS: { value: TextAnimation; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'popIn', label: 'ポップ' },
  { value: 'fadeIn', label: 'フェード' },
  { value: 'slideInUp', label: '下から' },
  { value: 'slideInDown', label: '上から' },
  { value: 'bounce', label: '弾む' },
  { value: 'typewriter', label: '1文字ずつ' }
]

const TAIL_SIDES: { value: TelopBubbleTail['side']; label: string }[] = [
  { value: 'bottom', label: '下' },
  { value: 'top', label: '上' },
  { value: 'left', label: '左' },
  { value: 'right', label: '右' }
]

/** 矢印の向きのボタン(画面の向き。y は下向き) */
const POINTER_DIRS: { x: number; y: number; glyph: string; label: string }[] = [
  { x: -1, y: -1, glyph: '↖', label: '左上' },
  { x: 0, y: -1, glyph: '↑', label: '上' },
  { x: 1, y: -1, glyph: '↗', label: '右上' },
  { x: -1, y: 0, glyph: '←', label: '左' },
  { x: 1, y: 0, glyph: '→', label: '右' },
  { x: -1, y: 1, glyph: '↙', label: '左下' },
  { x: 0, y: 1, glyph: '↓', label: '下' },
  { x: 1, y: 1, glyph: '↘', label: '右下' }
]

export function PropRow({
  label,
  children,
  title
}: {
  label: string
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div className="prop-row" title={title}>
      <span className="prop-label">{label}</span>
      <div className="prop-control">{children}</div>
    </div>
  )
}

export function TelopStyleFields({
  style,
  onPatch: patch,
  showKaraoke = false,
  placement
}: {
  style: TextStyle
  onPatch: (patch: Partial<TextStyle>) => void
  /** 単語の時刻を持つテロップだけ、カラオケの欄を出す */
  showKaraoke?: boolean
  /** 「位置・動き」の見出しの中に出す、呼び出し側の置き場所の欄(配置・回転など) */
  placement?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="telop-style-fields">
      <TextSection style={style} patch={patch} />
      <FillSection style={style} patch={patch} />
      <StrokeSection style={style} patch={patch} />
      <BackgroundSection style={style} patch={patch} />
      <ShadowSection style={style} patch={patch} />
      <GlowSection style={style} patch={patch} />
      <SpanSection style={style} patch={patch} />
      <PointerSection style={style} patch={patch} />
      <StyleSection
        id="motion"
        title="位置・動き"
        defaultOpen
        actions={<SectionPresetMenu section="motion" title="動き" style={style} onApply={patch} />}
      >
        {placement}
        <MotionFields style={style} patch={patch} />
        {showKaraoke && (
          <PropRow label="カラオケ">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={style.wordHighlight}
                onChange={(e) => patch({ wordHighlight: e.target.checked })}
              />
              話した単語を色付け
            </label>
            {style.wordHighlight && (
              <ColorField
                label="色付けの色"
                value={style.highlightColor}
                onChange={(hex) => patch({ highlightColor: hex })}
              />
            )}
          </PropRow>
        )}
      </StyleSection>
    </div>
  )
}

type SectionProps = { style: TextStyle; patch: (p: Partial<TextStyle>) => void }

// ------------------------------------------------------------------ 9. 動き(CapCut の 入り / 出 / ループ)

type MotionTab = 'in' | 'out' | 'loop'

function MotionFields({ style, patch }: SectionProps): React.JSX.Element {
  const [tab, setTab] = useState<MotionTab>('in')
  const charAnim = style.charAnimation ?? 'none'
  const exitAnim = style.exitAnimation ?? 'none'
  const loopAnim = style.loopAnimation ?? 'none'
  const mark = (on: boolean): string => (on ? ' •' : '')
  return (
    <div className="motion-fields">
      <PropRow label="動き">
        <Segmented
          label="動きの種類"
          value={tab}
          options={[
            {
              value: 'in',
              label: `入り${mark(style.animation !== 'none' || charAnim !== 'none')}`,
              title: '出てくるときの動き'
            },
            { value: 'out', label: `出${mark(exitAnim !== 'none')}`, title: '消えるときの動き' },
            {
              value: 'loop',
              label: `ループ${mark(loopAnim !== 'none')}`,
              title: '出ている間ずっと続く動き'
            }
          ]}
          onChange={setTab}
        />
      </PropRow>
      {tab === 'in' && (
        <>
          <PropRow label="全体">
            <select
              aria-label="登場の動き(全体)"
              value={style.animation}
              onChange={(e) => patch({ animation: e.target.value as TextAnimation })}
            >
              {ANIMATIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            {TEXT_ANIMATION_MS[style.animation] > 0 && (
              <span className="prop-unit">
                {(TEXT_ANIMATION_MS[style.animation] / (style.animationSpeed ?? 1) / 1000).toFixed(
                  2
                )}{' '}
                秒
              </span>
            )}
          </PropRow>
          <PropRow label="1文字ずつ">
            <select
              aria-label="1文字ずつの登場"
              value={charAnim}
              onChange={(e) => {
                const v = e.target.value as TelopCharAnimation
                patch({ charAnimation: v === 'none' ? undefined : v })
              }}
            >
              {CHAR_ANIMATIONS.map((a) => (
                <option key={a} value={a}>
                  {CHAR_ANIMATION_LABEL[a]}
                </option>
              ))}
            </select>
          </PropRow>
        </>
      )}
      {tab === 'out' && (
        <PropRow label="消え方">
          <select
            aria-label="消えるときの動き"
            value={exitAnim}
            onChange={(e) => {
              const v = e.target.value as TelopExitAnimation
              patch({ exitAnimation: v === 'none' ? undefined : v })
            }}
          >
            {EXIT_ANIMATIONS.map((a) => (
              <option key={a} value={a}>
                {EXIT_ANIMATION_LABEL[a]}
              </option>
            ))}
          </select>
        </PropRow>
      )}
      {tab === 'loop' && (
        <PropRow label="ループ">
          <select
            aria-label="出ている間の動き"
            value={loopAnim}
            onChange={(e) => {
              const v = e.target.value as TelopLoopAnimation
              patch({ loopAnimation: v === 'none' ? undefined : v })
            }}
          >
            {LOOP_ANIMATIONS.map((a) => (
              <option key={a} value={a}>
                {LOOP_ANIMATION_LABEL[a]}
              </option>
            ))}
          </select>
        </PropRow>
      )}
      <PropRow label="速さ" title="入り・出・ループの動きの速さ(1 が標準)">
        <NumberSlider
          label="動きの速さ"
          value={style.animationSpeed ?? 1}
          onChange={(v) => patch({ animationSpeed: v === 1 ? undefined : v })}
          min={0.25}
          max={4}
          step={0.05}
          unit="倍"
        />
      </PropRow>
    </div>
  )
}

// ------------------------------------------------------------------ 1. テキスト

function TextSection({ style, patch }: SectionProps): React.JSX.Element {
  const weight = telopFontWeight(style)
  const fontLabel = FONT_FAMILY_OPTIONS.find((f) => f.value === style.fontFamily)?.label
  return (
    <StyleSection
      id="text"
      actions={<SectionPresetMenu section="text" title="テキスト" style={style} onApply={patch} />}
      title="テキスト"
      defaultOpen
      summary={`${fontLabel?.split(/[((]/)[0].trim() ?? ''} ${style.fontSize}px`}
    >
      <PropRow label="書体">
        <FontPicker value={style.fontFamily} onChange={(v) => patch({ fontFamily: v })} />
      </PropRow>
      <PropRow label="サイズ">
        <NumberSlider
          label="文字の大きさ"
          value={style.fontSize}
          onChange={(v) => patch({ fontSize: Math.round(v) })}
          min={8}
          max={300}
          sliderMin={12}
          sliderMax={200}
          unit="px"
        />
      </PropRow>
      <PropRow label="太さ">
        <select
          aria-label="文字の太さ"
          value={weight}
          onChange={(e) => {
            const w = Number(e.target.value)
            patch({ fontWeight: w, bold: w >= 600 })
          }}
        >
          {FONT_WEIGHT_OPTIONS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`toggle-chip ${weight >= 600 ? 'active' : ''}`}
          aria-pressed={weight >= 600}
          aria-label="太字"
          title="太字"
          onClick={() => patch({ bold: weight < 600, fontWeight: undefined })}
        >
          B
        </button>
        <button
          type="button"
          className={`toggle-chip italic ${style.italic ? 'active' : ''}`}
          aria-pressed={style.italic}
          aria-label="斜体"
          title="斜体"
          onClick={() => patch({ italic: !style.italic })}
        >
          I
        </button>
      </PropRow>
      <PropRow label="組み方">
        <Segmented
          label="組み方"
          value={style.vertical ? 'v' : 'h'}
          options={[
            { value: 'h', label: '横書き' },
            { value: 'v', label: '縦書き', title: '右の列から左へ。長音・括弧は縦向きに回します' }
          ]}
          onChange={(v) => patch({ vertical: v === 'v' ? true : undefined })}
        />
      </PropRow>
      <PropRow label="揃え">
        <Segmented
          label={style.vertical ? '列の揃え' : '行揃え'}
          value={style.align ?? 'center'}
          options={
            style.vertical
              ? [
                  { value: 'left', label: '上', title: '上揃え' },
                  { value: 'center', label: '中', title: '中央揃え' },
                  { value: 'right', label: '下', title: '下揃え' }
                ]
              : [
                  { value: 'left', label: <AlignGlyph align="left" />, title: '左揃え' },
                  { value: 'center', label: <AlignGlyph align="center" />, title: '中央揃え' },
                  { value: 'right', label: <AlignGlyph align="right" />, title: '右揃え' }
                ]
          }
          onChange={(v) => patch({ align: v === 'center' ? undefined : v })}
        />
      </PropRow>
      {!style.vertical && (
        <PropRow
          label="アーチ"
          title="文字を弧に沿って曲げます(正で山なり、負で谷なり。0 でまっすぐ)"
        >
          <NumberSlider
            label="アーチ(曲げ)"
            value={style.arc ?? 0}
            onChange={(v) => patch({ arc: v === 0 ? undefined : v })}
            min={-270}
            max={270}
            sliderMin={-180}
            sliderMax={180}
            unit="度"
          />
        </PropRow>
      )}
      <PropRow label="字間">
        <NumberSlider
          label="字間"
          value={style.letterSpacing}
          onChange={(v) => patch({ letterSpacing: v })}
          min={-20}
          max={100}
          sliderMin={-10}
          sliderMax={40}
          unit="px"
        />
      </PropRow>
      <PropRow label="行間">
        <NumberSlider
          label="行の高さ"
          value={style.lineHeight ?? TELOP_LINE_HEIGHT_EM}
          onChange={(v) => patch({ lineHeight: v })}
          min={0.6}
          max={3}
          step={0.05}
          unit="倍"
        />
      </PropRow>
      <PropRow label="不透明度">
        <NumberSlider
          label="文字全体の不透明度"
          value={style.opacity ?? 1}
          onChange={(v) => patch({ opacity: v >= 1 ? undefined : v })}
          min={0}
          max={100}
          scale={100}
          unit="%"
        />
      </PropRow>
    </StyleSection>
  )
}

function AlignGlyph({ align }: { align: 'left' | 'center' | 'right' }): React.JSX.Element {
  const rows = [12, 8, 12, 6]
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" aria-hidden="true">
      {rows.map((w, i) => {
        const x = align === 'left' ? 1 : align === 'right' ? 13 - w : (14 - w) / 2
        return (
          <rect key={i} x={x} y={1 + i * 3} width={w} height={1.6} rx={0.5} fill="currentColor" />
        )
      })}
    </svg>
  )
}

// ------------------------------------------------------------------ 2. 塗り

function FillSection({ style, patch }: SectionProps): React.JSX.Element {
  const gradient = effectiveFillGradient(style)
  return (
    <StyleSection
      id="fill"
      actions={<SectionPresetMenu section="fill" title="塗り" style={style} onApply={patch} />}
      title="塗り"
      defaultOpen
      summary={gradient ? 'グラデーション' : undefined}
    >
      <FillField
        label="文字の塗り"
        rowLabel="塗り"
        color={style.color}
        gradient={gradient}
        onChange={({ color, gradient: g }) =>
          // 旧形式の縦2色(gradientColor)は、触ったら新しい形に移す
          patch({ color: color ?? style.color, fillGradient: g, gradientColor: undefined })
        }
      />
    </StyleSection>
  )
}

// ------------------------------------------------------------------ 3. 縁

function StrokeSection({ style, patch }: SectionProps): React.JSX.Element {
  const list = strokesFromStyle(style)
  const set = (next: TelopStroke[]): void => patch(strokesToStyle(next))
  const update = (i: number, p: Partial<TelopStroke>): void =>
    set(list.map((s, j) => (j === i ? { ...s, ...p } : s)))
  return (
    <StyleSection
      id="stroke"
      actions={<SectionPresetMenu section="stroke" title="縁" style={style} onApply={patch} />}
      title="縁(ストローク)"
      defaultOpen
      summary={list.length > 0 ? `${list.length} 本` : 'なし'}
    >
      {list.length === 0 && <p className="hint-text style-note">縁はありません。</p>}
      {list.map((s, i) => (
        <div key={i} className="stroke-card">
          <div className="stroke-card-head">
            <span className="stroke-card-title">
              縁 {i + 1}
              <span className="stroke-card-sub">
                {list.length === 1
                  ? ''
                  : i === 0
                    ? '(いちばん内側)'
                    : i === list.length - 1
                      ? '(いちばん外側)'
                      : ''}
              </span>
            </span>
            <div className="stroke-card-tools">
              <button
                type="button"
                className="icon-chip"
                aria-label={`縁 ${i + 1} を内側へ`}
                title="内側へ"
                disabled={i === 0}
                onClick={() => set(moveStroke(list, i, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-chip"
                aria-label={`縁 ${i + 1} を外側へ`}
                title="外側へ"
                disabled={i === list.length - 1}
                onClick={() => set(moveStroke(list, i, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-chip danger"
                aria-label={`縁 ${i + 1} を消す`}
                title="この縁を消す"
                onClick={() => set(list.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          </div>
          <PropRow label="太さ">
            <NumberSlider
              label={`縁 ${i + 1} の太さ`}
              value={s.width}
              onChange={(v) => update(i, { width: v })}
              min={0.5}
              max={60}
              step={0.5}
              sliderMin={0.5}
              sliderMax={30}
              unit="px"
            />
          </PropRow>
          <FillField
            label={`縁 ${i + 1} の色`}
            color={s.color}
            gradient={s.gradient}
            onChange={({ color, gradient }) => update(i, { color: color ?? s.color, gradient })}
          />
        </div>
      ))}
      <button
        type="button"
        className="small-button add-row-button"
        disabled={list.length >= MAX_STROKES}
        title="いちばん外側に縁を1本足します(バラエティの二重縁・三重縁)"
        onClick={() => set(addStroke(list))}
      >
        + 縁を追加
      </button>
    </StyleSection>
  )
}

// ------------------------------------------------------------------ 4. 背景

function BackgroundSection({ style, patch }: SectionProps): React.JSX.Element {
  const shape = style.backgroundShape ?? 'lines'
  const autoPad = textBoxPaddingPx(style.fontSize)
  const pad = style.backgroundPadding ?? {
    x: Math.round(autoPad.x),
    y: Math.round(autoPad.y)
  }
  const tail = style.bubbleTail
  const border = style.backgroundBorder
  return (
    <StyleSection
      id="background"
      actions={
        <SectionPresetMenu section="background" title="背景" style={style} onApply={patch} />
      }
      title="背景"
      enabled={style.background}
      // 付けたときは、文字が読める色・濃さから始める(白文字に白い帯、のようにならないように)
      onToggle={(on) =>
        patch(on ? { background: true, ...readableBackground(style) } : { background: false })
      }
      summary={
        style.background ? { lines: '行ごと', block: '1枚の板', bubble: '吹き出し' }[shape] : 'なし'
      }
    >
      <PropRow label="形">
        <Segmented
          label="背景の形"
          value={shape}
          options={[
            { value: 'lines', label: '行ごと', title: '行ごとの帯(座布団)' },
            { value: 'block', label: '1枚の板', title: '全体を1枚の板で敷く' },
            { value: 'bubble', label: '吹き出し', title: 'しっぽの付いた吹き出し' }
          ]}
          onChange={(v) =>
            patch({
              backgroundShape: v === 'lines' ? undefined : v,
              ...(v === 'bubble' && !tail
                ? { bubbleTail: { side: 'bottom', at: 0.3, length: 24 } }
                : {}),
              ...(v === 'bubble' && style.backgroundRadius === undefined
                ? { backgroundRadius: 24 }
                : {})
            })
          }
        />
      </PropRow>
      <FillField
        label="背景の色"
        color={style.backgroundColor}
        gradient={style.backgroundGradient}
        onChange={({ color, gradient }) =>
          patch({ backgroundColor: color ?? style.backgroundColor, backgroundGradient: gradient })
        }
      />
      <PropRow label="不透明度">
        <NumberSlider
          label="背景の不透明度"
          value={style.backgroundOpacity}
          onChange={(v) => patch({ backgroundOpacity: v })}
          min={0}
          max={100}
          scale={100}
          unit="%"
        />
      </PropRow>
      <PropRow label="角の丸み">
        <NumberSlider
          label="背景の角の丸み"
          value={style.backgroundRadius ?? 0}
          onChange={(v) => patch({ backgroundRadius: v > 0 ? v : undefined })}
          min={0}
          max={500}
          sliderMax={100}
          unit="px"
        />
      </PropRow>
      <PropRow label="余白">
        <span className="prop-unit">横</span>
        <NumberSlider
          slider={false}
          label="背景の余白(横)"
          value={pad.x}
          onChange={(v) => patch({ backgroundPadding: { x: v, y: pad.y } })}
          min={0}
          max={500}
        />
        <span className="prop-unit">縦</span>
        <NumberSlider
          slider={false}
          label="背景の余白(縦)"
          value={pad.y}
          onChange={(v) => patch({ backgroundPadding: { x: pad.x, y: v } })}
          min={0}
          max={500}
          unit="px"
        />
        {style.backgroundPadding ? (
          <button
            type="button"
            className="link-button"
            title="文字の大きさに合わせた余白に戻します"
            onClick={() => patch({ backgroundPadding: undefined })}
          >
            自動に戻す
          </button>
        ) : (
          <span className="prop-unit">(自動)</span>
        )}
      </PropRow>
      <PropRow label="斜め">
        <NumberSlider
          label="背景の傾き"
          value={style.backgroundSkew ?? 0}
          onChange={(v) => patch({ backgroundSkew: v === 0 ? undefined : v })}
          min={-45}
          max={45}
          unit="度"
        />
      </PropRow>
      <PropRow label="枠線">
        <input
          type="checkbox"
          aria-label="背景に枠線を付ける"
          checked={Boolean(border && border.width > 0)}
          onChange={(e) =>
            patch({
              backgroundBorder: e.target.checked ? { color: '#ffffff', width: 3 } : undefined
            })
          }
        />
        {border && border.width > 0 && (
          <>
            <ColorField
              label="枠線の色"
              value={border.color}
              onChange={(hex) => patch({ backgroundBorder: { ...border, color: hex } })}
            />
            <NumberSlider
              label="枠線の太さ"
              value={border.width}
              onChange={(v) => patch({ backgroundBorder: { ...border, width: v } })}
              min={0.5}
              max={100}
              step={0.5}
              sliderMax={20}
              unit="px"
            />
          </>
        )}
      </PropRow>
      {shape === 'bubble' && (
        <>
          <PropRow label="しっぽ">
            <select
              aria-label="しっぽの向き"
              value={tail?.side ?? 'none'}
              onChange={(e) =>
                patch({
                  bubbleTail:
                    e.target.value === 'none'
                      ? undefined
                      : {
                          side: e.target.value as TelopBubbleTail['side'],
                          at: tail?.at ?? 0.3,
                          length: tail?.length ?? 24
                        }
                })
              }
            >
              <option value="none">なし</option>
              {TAIL_SIDES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}の辺から
                </option>
              ))}
            </select>
          </PropRow>
          {tail && (
            <>
              <PropRow label="しっぽ位置">
                <NumberSlider
                  label="しっぽの位置"
                  value={tail.at}
                  onChange={(v) => patch({ bubbleTail: { ...tail, at: v } })}
                  min={0}
                  max={100}
                  scale={100}
                  unit="%"
                />
              </PropRow>
              <PropRow label="しっぽ長さ">
                <NumberSlider
                  label="しっぽの長さ"
                  value={tail.length}
                  onChange={(v) => patch({ bubbleTail: { ...tail, length: v } })}
                  min={0}
                  max={400}
                  sliderMax={120}
                  unit="px"
                />
              </PropRow>
            </>
          )}
        </>
      )}
    </StyleSection>
  )
}

// ------------------------------------------------------------------ 5. 影

function ShadowSection({ style, patch }: SectionProps): React.JSX.Element {
  const s = shadowDisplay(style)
  const custom =
    style.shadowColor !== undefined ||
    style.shadowOpacity !== undefined ||
    style.shadowAngle !== undefined ||
    style.shadowDistance !== undefined ||
    style.shadowBlur !== undefined
  return (
    <StyleSection
      id="shadow"
      actions={<SectionPresetMenu section="shadow" title="影" style={style} onApply={patch} />}
      title="影"
      enabled={style.shadow}
      onToggle={(on) => patch({ shadow: on })}
      summary={style.shadow ? undefined : 'なし'}
    >
      <PropRow label="色">
        <ColorField
          label="影の色"
          value={s.color}
          onChange={(hex) => patch({ shadowColor: hex })}
        />
        {custom && (
          <button
            type="button"
            className="link-button"
            title="向き・距離・濃さを、従来の影(右下へ硬く落とす)に戻します"
            onClick={() =>
              patch({
                shadowColor: undefined,
                shadowOpacity: undefined,
                shadowAngle: undefined,
                shadowDistance: undefined,
                shadowBlur: undefined
              })
            }
          >
            既定に戻す
          </button>
        )}
      </PropRow>
      <PropRow label="不透明度">
        <NumberSlider
          label="影の不透明度"
          value={s.opacity}
          onChange={(v) => patch({ shadowOpacity: v })}
          min={0}
          max={100}
          scale={100}
          unit="%"
        />
      </PropRow>
      <PropRow label="角度">
        <AngleDial
          label="影の向き"
          kind="shadow"
          value={s.angle}
          onChange={(v) => patch({ shadowAngle: v, shadowDistance: s.distance })}
        />
        <NumberSlider
          slider={false}
          label="影の角度"
          value={s.angle}
          onChange={(v) => patch({ shadowAngle: v, shadowDistance: s.distance })}
          min={-180}
          max={180}
          unit="度"
        />
      </PropRow>
      <PropRow label="距離">
        <NumberSlider
          label="影の距離"
          value={s.distance}
          onChange={(v) => patch({ shadowDistance: v, shadowAngle: s.angle })}
          min={0}
          max={200}
          step={0.5}
          sliderMax={60}
          unit="px"
        />
      </PropRow>
      <PropRow label="ぼかし">
        <NumberSlider
          label="影のぼかし"
          value={s.blur}
          onChange={(v) => patch({ shadowBlur: v > 0 ? v : undefined })}
          min={0}
          max={200}
          sliderMax={60}
          unit="px"
        />
      </PropRow>
    </StyleSection>
  )
}

// ------------------------------------------------------------------ 6. 光彩

function GlowSection({ style, patch }: SectionProps): React.JSX.Element {
  const glow = style.glow
  return (
    <StyleSection
      id="glow"
      actions={<SectionPresetMenu section="glow" title="光彩" style={style} onApply={patch} />}
      title="光彩(グロー)"
      enabled={Boolean(glow)}
      onToggle={(on) =>
        patch({ glow: on ? { color: '#ffe066', size: 18, opacity: 0.8 } : undefined })
      }
      summary={glow ? undefined : 'なし'}
    >
      {glow && (
        <>
          <PropRow label="色">
            <ColorField
              label="光彩の色"
              value={glow.color}
              onChange={(hex) => patch({ glow: { ...glow, color: hex } })}
            />
          </PropRow>
          <PropRow label="大きさ">
            <NumberSlider
              label="光彩の大きさ"
              value={glow.size}
              onChange={(v) => patch({ glow: { ...glow, size: v } })}
              min={1}
              max={200}
              sliderMax={80}
              unit="px"
            />
          </PropRow>
          <PropRow label="不透明度">
            <NumberSlider
              label="光彩の不透明度"
              value={glow.opacity}
              onChange={(v) => patch({ glow: { ...glow, opacity: v } })}
              min={0}
              max={100}
              scale={100}
              unit="%"
            />
          </PropRow>
        </>
      )}
    </StyleSection>
  )
}

// ------------------------------------------------------------------ 7. 部分の装飾

const SPAN_KINDS: {
  key: 'firstLine' | 'accent' | 'sub'
  label: string
  scale: number
  color?: string
}[] = [
  { key: 'firstLine', label: '1行目', scale: 0.7 },
  { key: 'accent', label: '**強調**', scale: 1.3, color: '#ffe600' },
  { key: 'sub', label: '__小さく__', scale: 0.7 }
]

function SpanSection({ style, patch }: SectionProps): React.JSX.Element {
  const used = SPAN_KINDS.filter((k) => style[k.key]).length
  return (
    <StyleSection
      id="spans"
      title="部分の装飾"
      summary={used > 0 ? `${used} 種類` : undefined}
      actions={
        <SectionPresetMenu section="spans" title="部分の装飾" style={style} onApply={patch} />
      }
    >
      <p className="hint-text style-note">
        本文で <code>**強調**</code> と囲んだ所、<code>__小さく__</code> と囲んだ所、
        改行の前の1行目だけを、別の大きさ・色にできます(値段・「Q.」・章の番号など)。 ふりがなは{' '}
        <code>漢字《かんじ》</code> または <code>｜親文字《るび》</code> と書きます。
      </p>
      {SPAN_KINDS.map((k) => {
        const span = style[k.key]
        const set = (next: TelopSpanStyle | undefined): void => patch({ [k.key]: next })
        return (
          <div key={k.key} className={`span-card ${span ? '' : 'off'}`}>
            <label className="checkbox-label span-card-head">
              <input
                type="checkbox"
                checked={Boolean(span)}
                onChange={(e) =>
                  set(
                    e.target.checked
                      ? { scale: k.scale, ...(k.color ? { color: k.color } : {}) }
                      : undefined
                  )
                }
              />
              <span className="span-card-title">{k.label}</span>
            </label>
            {span && (
              <>
                <PropRow label="大きさ">
                  <NumberSlider
                    label={`${k.label}の大きさ`}
                    value={span.scale ?? 1}
                    onChange={(v) => set({ ...span, scale: v })}
                    min={20}
                    max={500}
                    sliderMax={300}
                    step={5}
                    scale={100}
                    unit="%"
                  />
                </PropRow>
                <FillField
                  label={`${k.label}の色`}
                  allowInherit
                  fallbackColor={k.color ?? style.color}
                  color={span.color}
                  gradient={span.gradient}
                  onChange={({ color, gradient }) => set({ ...span, color, gradient })}
                />
              </>
            )}
          </div>
        )
      })}
    </StyleSection>
  )
}

// ------------------------------------------------------------------ 8. 矢印

function PointerSection({ style, patch }: SectionProps): React.JSX.Element {
  const p = style.pointer
  return (
    <StyleSection
      id="pointer"
      actions={<SectionPresetMenu section="pointer" title="矢印" style={style} onApply={patch} />}
      title="矢印"
      enabled={Boolean(p)}
      onToggle={(on) =>
        patch({
          pointer: on ? { dx: 0.12, dy: 0.12, color: '#ff3b30', width: 6, hand: true } : undefined
        })
      }
      summary={p ? undefined : 'なし'}
    >
      {p && (
        <>
          <PropRow label="向き">
            <div className="dir-pad" role="group" aria-label="矢印の向き">
              {POINTER_DIRS.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  className="icon-chip"
                  aria-label={`矢印を${d.label}へ`}
                  title={d.label}
                  onClick={() => patch({ pointer: { ...p, ...pointerToward(p, d.x, d.y) } })}
                >
                  {d.glyph}
                </button>
              ))}
            </div>
          </PropRow>
          <PropRow label="横" title="矢印の先の位置(テロップの中心から、画面の幅に対する %)">
            <NumberSlider
              label="矢印の先(横)"
              value={p.dx}
              onChange={(v) => patch({ pointer: { ...p, dx: v } })}
              min={-200}
              max={200}
              sliderMin={-60}
              sliderMax={60}
              scale={100}
              unit="%"
            />
          </PropRow>
          <PropRow label="縦" title="矢印の先の位置(テロップの中心から、画面の高さに対する %)">
            <NumberSlider
              label="矢印の先(縦)"
              value={p.dy}
              onChange={(v) => patch({ pointer: { ...p, dy: v } })}
              min={-200}
              max={200}
              sliderMin={-60}
              sliderMax={60}
              scale={100}
              unit="%"
            />
          </PropRow>
          <PropRow label="色・太さ">
            <ColorField
              label="矢印の色"
              value={p.color}
              onChange={(hex) => patch({ pointer: { ...p, color: hex } })}
            />
            <NumberSlider
              label="矢印の太さ"
              value={p.width}
              onChange={(v) => patch({ pointer: { ...p, width: v } })}
              min={1}
              max={60}
              sliderMax={30}
              unit="px"
            />
          </PropRow>
          <PropRow label="">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={Boolean(p.hand)}
                onChange={(e) => patch({ pointer: { ...p, hand: e.target.checked || undefined } })}
              />
              手書き風に曲げる
            </label>
          </PropRow>
        </>
      )}
    </StyleSection>
  )
}
