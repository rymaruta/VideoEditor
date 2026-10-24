/* eslint-disable @typescript-eslint/explicit-function-return-type -- 監査で書いた fuzz(e1507cb の範囲の作り直しの案)を取り込んだもの */
// 範囲の自動編集・案の替え・試しに見る を、手の編集・ロック・作り直し・取り消しと混ぜて回す。
// 試して閉じたら試す前と同じ・範囲の記録が取り消し/やり直しで行き来することは失敗にする(ほかの印はログ)
// 監査は SEEDS=1..300 NSTEPS=40 で回した
import { describe, it, vi } from 'vitest'
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
import { sameProjectContent } from '@renderer/lib/projectEquality'
import {
  mainLength,
  type RangedEditOptions,
  type RangedPreview
} from '@renderer/lib/rangedAutoEdit'
import {
  clipTimes,
  commonWindowOf,
  matchLockBlocks,
  timelineBlocksOf,
  timelineWindowOf
} from '@shared/roughCut/range'
import {
  angleAlternatives,
  subtractRanges,
  unionRanges,
  type CameraSeg
} from '@shared/roughCut/overrides'
import type { Project } from '@shared/types'
import { autoTelopKey } from '@shared/telop/manual'
import { markIn, markOut, rippleDelete } from '@renderer/lib/editCommands'
import { cov, episode2, inter, len, memory, project } from './h'

const SEEDS = (process.env.SEEDS ?? '1,2,3,4,5,6,7,8').split(',').map(Number)
const STEPS = Number(process.env.NSTEPS ?? 25)

function fmtSegs(s: CameraSeg[]): string {
  return s.map((x) => `${x.start.toFixed(2)}-${x.end.toFixed(2)}:${x.cameraId}`).join(' ')
}

function voiceOverlap(pp: {
  audioTracks: {
    multicamSourceId?: string
    autoRole?: string
    name: string
    clips: { startTime: number; inPoint: number; outPoint: number; speed?: number }[]
  }[]
}): string[] {
  const out: string[] = []
  for (const t of pp.audioTracks) {
    if (!t.multicamSourceId && t.autoRole !== 'se') continue
    const cs = [...t.clips]
      .map((c) => ({ s: c.startTime, e: c.startTime + (c.outPoint - c.inPoint) / (c.speed || 1) }))
      .sort((a, b) => a.s - b.s)
    for (let i = 1; i < cs.length; i++)
      if (cs[i].s < cs[i - 1].e - 0.02 && t.multicamSourceId)
        out.push(`${t.name}@${cs[i].s.toFixed(2)}(${(cs[i - 1].e - cs[i].s).toFixed(2)})`)
  }
  return out
}

function desync(pp: Project, lo: number, hi: number): string[] {
  const info = pp.multicam!
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const t = clipTimes(pp.clips)
  const videoAt = (x: number): number | null => {
    const i = pp.clips.findIndex((_, k) => t[k].start <= x && t[k].end > x)
    if (i < 0) return null
    const c = pp.clips[i]
    const f = fileOf.get(c.assetId)
    if (!f) return null
    return f.start + (c.inPoint + (x - t[i].start) * (c.speed || 1)) / f.rate
  }
  const out: string[] = []
  for (const tr of pp.audioTracks) {
    if (!tr.multicamSourceId) continue
    for (const c of tr.clips) {
      const f = fileOf.get(c.assetId)
      if (!f || c.linkedClipId) continue
      const len = (c.outPoint - c.inPoint) / (c.speed || 1)
      for (const q of [0.25, 0.5, 0.75]) {
        const x = c.startTime + len * q
        if (x < lo || x >= hi) continue
        const v = videoAt(x)
        if (v === null) continue
        const a = f.start + (c.inPoint + (x - c.startTime) * (c.speed || 1)) / f.rate
        if (Math.abs(a - v) > 0.05) {
          out.push(`${tr.name}@${x.toFixed(2)} d=${(a - v).toFixed(2)}`)
          break
        }
      }
    }
  }
  return out
}
describe('audit fuzz', () => {
  for (const seed0 of SEEDS)
    it(`seed ${seed0}`, async () => {
      let seed = seed0 * 7919 + 13
      const rand = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
      await episode2()
      const log: string[] = []
      const fail = (msg: string): never => {
        throw new Error(`${msg}\nseed=${seed0}\n${log.join('\n')}`)
      }
      for (let step = 0; step < STEPS; step++) {
        const p = project()
        const total = mainLength(p)
        const t = clipTimes(p.clips)
        const op = pick([
          'trim',
          'trim',
          'remove',
          'angle',
          'angle',
          'speed',
          'move',
          'ripple',
          'range',
          'range',
          'range',
          'iorange',
          'lock',
          'unlock',
          'rebuild',
          'rebuild',
          'undo',
          'redo',
          'undo',
          'target',
          'range',
          'trialclose',
          'trialclose'
        ])
        if (op === 'speed' && p.clips.length > 0) {
          const i = Math.floor(rand() * p.clips.length)
          useProjectStore.getState().updateClipSpeed(p.clips[i].id, pick([0.5, 1.5, 2]))
          log.push(`speed clip ${i}`)
        } else if (op === 'move' && p.clips.length > 2) {
          const i = Math.floor(rand() * p.clips.length),
            j = Math.floor(rand() * p.clips.length)
          useProjectStore.getState().moveClipToIndex(p.clips[i].id, j)
          log.push(`move ${i}->${j}`)
        } else if (op === 'ripple' && total > 6) {
          const a = Math.round(rand() * (total - 3) * 30) / 30,
            b = Math.min(total, Math.round((a + 0.5 + rand() * 2) * 30) / 30)
          useProjectStore.getState().selectClip(null)
          useProjectStore.getState().seekTo(a)
          markIn()
          useProjectStore.getState().seekTo(b)
          markOut()
          const ok = rippleDelete()
          log.push(`ripple-delete ${a.toFixed(2)}-${b.toFixed(2)} ${ok}`)
        }
        if (op === 'trim' && p.clips.length > 1) {
          const i = Math.floor(rand() * p.clips.length)
          const c = p.clips[i]
          const d = Math.min(1 + rand() * 2, (t[i].end - t[i].start) * 0.4)
          if (rand() < 0.5)
            useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - d)
          else useProjectStore.getState().updateClipTrim(c.id, c.inPoint + d, c.outPoint)
          log.push(`trim clip ${i} by ${d.toFixed(2)}`)
        } else if (op === 'remove' && p.clips.length > 3) {
          const i = Math.floor(rand() * p.clips.length)
          useProjectStore.getState().removeClip(p.clips[i].id)
          log.push(`remove clip ${i}`)
        } else if (op === 'angle') {
          const i = Math.floor(rand() * p.clips.length)
          const c = p.clips[i]
          const alts = angleAlternatives(c, p.multicam!).filter((a) => (a.clips?.length ?? 0) > 0)
          const cur = p.multicam!.files.find((f) => f.assetId === c.assetId)?.sourceId
          const other = alts.find((a) => a.sourceId !== cur)
          if (other) {
            useProjectStore.getState().switchClipAngle(c.id, other.sourceId)
            log.push(`angle clip ${i} -> ${other.sourceId}`)
          }
        } else if (op === 'range' || op === 'iorange') {
          const a = Math.round(rand() * total * 0.7 * 30) / 30
          const b = Math.min(total, Math.round((a + 4 + rand() * total * 0.4) * 30) / 30)
          const o: RangedEditOptions = {
            steps: {
              cut: rand() < 0.7,
              angles: rand() < 0.7,
              speech: rand() < 0.8,
              effects: true,
              se: rand() < 0.7,
              cg: true,
              bgm: rand() < 0.5
            },
            keepLength: rand() < 0.5,
            keepInside: rand() < 0.5,
            lockAfter: rand() < 0.25
          }
          const exact = op === 'iorange' || rand() < 0.3
          let list: RangedPreview[] | undefined
          let pv: RangedPreview
          if (rand() < 0.6) {
            const rv = await usePipelineStore
              .getState()
              .prepareRangedVariants({ start: a, end: b }, o, { exact })
            if (!rv.ok) {
              log.push(
                `variants ${a.toFixed(2)}-${b.toFixed(2)} refused: ${rv.reason.slice(0, 30)}`
              )
              continue
            }
            list = rv.previews
            pv = pick(list)
          } else {
            const r = await usePipelineStore
              .getState()
              .prepareRangedEdit({ start: a, end: b }, o, { exact })
            if (!r.ok) {
              log.push(`range ${a.toFixed(2)}-${b.toFixed(2)} refused: ${r.reason.slice(0, 30)}`)
              continue
            }
            pv = r.preview
          }
          const memBefore = memory()
          const base = project()
          const bt = clipTimes(base.clips)
          const outsideBefore = base.clips.filter(
            (_, k) => bt[k].end <= pv.range.start + 1e-6 || bt[k].start >= pv.range.end - 1e-6
          )
          const runs0 = usePipelineStore.getState().rangeRuns.length
          const past0 = useProjectStore.getState().past.length
          if (!usePipelineStore.getState().applyRangedEdit(pv, list).ok) fail('apply refused')
          if (list && list.length > 1) {
            const others = list.filter((x) => x !== pv)
            const n = 1 + Math.floor(rand() * 2)
            for (let k = 0; k < n; k++) {
              const other = pick(others)
              const rs = usePipelineStore.getState().switchRangedVariant(other)
              if (!rs.ok) fail('switch refused ' + rs.reason)
              log.push(`  switch ${pv.variant.id} -> ${other.variant.id}`)
              pv = other
            }
          }
          if (useProjectStore.getState().past.length !== past0 + 1) fail('history not +1')
          const runs1 = usePipelineStore.getState().rangeRuns.length
          log.push(
            `range ${pv.range.start.toFixed(2)}-${pv.range.end.toFixed(2)} win ${pv.window.start.toFixed(2)}-${pv.window.end.toFixed(2)} ${JSON.stringify(o)}`
          )
          const after = project()
          for (const c of outsideBefore) if (!after.clips.includes(c)) fail('outside clip changed')
          // 窓の外の人の手直しの記憶は変わらない
          const memAfter = memory()
          const w = [pv.window]
          const outs = (rs: { start: number; end: number }[]) => subtractRanges(unionRanges(rs), w)
          const dRem =
            len(subtractRanges(outs(memBefore.removed), outs(memAfter.removed))) +
            len(subtractRanges(outs(memAfter.removed), outs(memBefore.removed)))
          const dAdd =
            len(subtractRanges(outs(memBefore.added), outs(memAfter.added))) +
            len(subtractRanges(outs(memAfter.added), outs(memBefore.added)))
          if (dRem > 0.05 || dAdd > 0.05)
            fail(
              `outside memory changed rem=${dRem} add=${dAdd}\n addBefore=${JSON.stringify(outs(memBefore.added).map((r) => [+r.start.toFixed(2), +r.end.toFixed(2)]))}\n addAfter=${JSON.stringify(outs(memAfter.added).map((r) => [+r.start.toFixed(2), +r.end.toFixed(2)]))}\n covBefore=${fmtSegs(cov(base))}\n covAfter=${fmtSegs(cov())}\n autoBefore=${fmtSegs(base.roughCutAuto ?? [])}\n autoAfter=${fmtSegs(project().roughCutAuto ?? [])}\n clipsBefore=${JSON.stringify(base.clips.map((c) => [c.assetId.slice(0, 4), +c.inPoint.toFixed(2), +c.outPoint.toFixed(2), c.speed]))}`
            )
          // 窓の中: 残すなら同じ / カットをやり直さないなら手で削った所は残っている
          const ins = (rs: { start: number; end: number }[]) => inter(unionRanges(rs), w)
          if (o.keepInside || !o.steps.cut) {
            const lost = len(subtractRanges(ins(memBefore.removed), ins(memAfter.removed)))
            const stillGone = len(subtractRanges(ins(memBefore.removed), cov()))
            if (stillGone > 0.05 && lost > 0.05)
              log.push(
                `  !! inside removed memory lost ${lost.toFixed(2)} (keepInside=${o.keepInside} cut=${o.steps.cut})`
              )
          }
          {
            const dups = (pp: typeof base) => {
              const m = new Map<string, number>()
              for (const x of pp.textOverlays) {
                const k = autoTelopKey(x)
                if (k) m.set(k, (m.get(k) ?? 0) + 1)
              }
              return [...m].filter(([, n]) => n > 1).map(([k]) => k)
            }
            const d0 = dups(base),
              d1 = dups(after)
            const newD = d1.filter((k) => !d0.includes(k))
            if (newD.length) {
              log.push(
                `  !!D duplicate auto telops after range: ${newD.length} ${newD.slice(0, 3).join(',')}`
              )
              for (const k of newD.slice(0, 2))
                log.push(
                  '    D ' +
                    after.textOverlays
                      .filter((x) => autoTelopKey(x) === k)
                      .map(
                        (x) =>
                          `[${x.startTime.toFixed(2)}-${x.endTime.toFixed(2)}] ${x.text.replace(/\n/g, '').slice(0, 10)} ed=${!!x.edited}`
                      )
                      .join(' | ') +
                    ` newRange=${pv.newRange.start.toFixed(2)}-${pv.newRange.end.toFixed(2)} speech=${o.steps.speech}`
                )
            }
          }
          {
            // 同じ発言のテロップが時間で重なる
            const sp = after.textOverlays
              .filter((x) => x.utteranceId)
              .sort((a, b) => a.startTime - b.startTime)
            let ov = 0
            for (let i = 0; i < sp.length; i++)
              for (let j = i + 1; j < sp.length && sp[j].startTime < sp[i].endTime - 0.05; j++)
                if (sp[j].utteranceId === sp[i].utteranceId) ov++
            const sp0 = base.textOverlays
              .filter((x) => x.utteranceId)
              .sort((a, b) => a.startTime - b.startTime)
            let ov0 = 0
            for (let i = 0; i < sp0.length; i++)
              for (let j = i + 1; j < sp0.length && sp0[j].startTime < sp0[i].endTime - 0.05; j++)
                if (sp0[j].utteranceId === sp0[i].utteranceId) ov0++
            if (ov > ov0) {
              log.push(`  !!E same-utterance telops overlap ${ov0}->${ov}`)
              if (process.env.DUMP_E)
                for (let i = 0; i < sp.length; i++)
                  for (let j = i + 1; j < sp.length && sp[j].startTime < sp[i].endTime - 0.05; j++)
                    if (sp[j].utteranceId === sp[i].utteranceId)
                      log.push(
                        `    E ${sp[i].text.replace(/\n/g, ' ').slice(0, 12)} [${sp[i].startTime.toFixed(2)}-${sp[i].endTime.toFixed(2)}] key=${autoTelopKey(sp[i])} / [${sp[j].startTime.toFixed(2)}-${sp[j].endTime.toFixed(2)}] key=${autoTelopKey(sp[j])} newRange=${pv.newRange.start.toFixed(2)}-${pv.newRange.end.toFixed(2)} oldRange=${pv.range.start.toFixed(2)}-${pv.range.end.toFixed(2)} inBase=${base.textOverlays.some((x) => x.id === sp[i].id)},${base.textOverlays.some((x) => x.id === sp[j].id)}`
                      )
            }
          }
          {
            const v0 = voiceOverlap(base),
              v1 = voiceOverlap(after)
            if (v1.length > v0.length)
              log.push(
                `  !!G voice overlap after range ${v0.length}->${v1.length} ${v1.slice(0, 3).join(' ')} newRange=${pv.newRange.start.toFixed(2)}-${pv.newRange.end.toFixed(2)}`
              )
          }
          {
            const d0 = desync(base, pv.range.start, pv.range.end),
              d1 = desync(after, pv.newRange.start, pv.newRange.end)
            if (d1.length > 0 && o.steps.cut)
              log.push(
                `  !!V voice desync inside range ${d0.length}->${d1.length} ${d1.slice(0, 3).join(' ')}`
              )
          }
          if (o.keepInside) {
            const handGone = subtractRanges(ins(memBefore.removed), cov(base))
            const refilled = len(inter(handGone, cov()))
            if (refilled > 0.05)
              log.push(
                `  !!B keepInside but hand-removed refilled ${refilled.toFixed(2)} keepLength=${o.keepLength} cut=${o.steps.cut}`
              )
          }
          // 取り消し1回で戻る、やり直しで同じ
          useProjectStore.getState().undo()
          if (!sameProjectContent({ ...project(), autoEdit: base.autoEdit }, base))
            fail('undo not exact')
          if (usePipelineStore.getState().rangeRuns.length !== runs0)
            fail(`rangeRuns after undo ${usePipelineStore.getState().rangeRuns.length} vs ${runs0}`)
          useProjectStore.getState().redo()
          if (!sameProjectContent({ ...project(), autoEdit: after.autoEdit }, after))
            fail('redo not exact')
          if (usePipelineStore.getState().rangeRuns.length !== runs1) fail(`rangeRuns after redo`)
          // 範囲の外(前)の発言テロップの時刻の合併は変わらない / 境の切れ端の同文連続を数える
          {
            const un = (pp: typeof base, lo: number, hi: number) =>
              unionRanges(
                pp.textOverlays
                  .filter((x) => x.utteranceId)
                  .map((x) => ({ start: Math.max(lo, x.startTime), end: Math.min(hi, x.endTime) }))
                  .filter((x) => x.end > x.start + 1e-6)
              )
            const a0 = un(base, 0, pv.range.start),
              a1 = un(after, 0, pv.range.start)
            const lost = len(subtractRanges(a0, a1))
            if (lost > 0.05 && o.steps.speech)
              log.push(`  !!S speech telop time lost before range ${lost.toFixed(2)}`)
            const sp = after.textOverlays
              .filter((x) => x.utteranceId)
              .sort((x, y) => x.startTime - y.startTime)
            for (let i = 0; i < sp.length; i++)
              for (let j = 0; j < sp.length; j++)
                if (
                  i !== j &&
                  sp[i].utteranceId === sp[j].utteranceId &&
                  Math.abs(sp[i].endTime - sp[j].startTime) < 0.02 &&
                  sp[i].text === sp[j].text
                )
                  log.push(
                    `  ~~same text consecutive at ${sp[i].endTime.toFixed(2)} (range ${pv.newRange.start.toFixed(2)}-${pv.newRange.end.toFixed(2)})`
                  )
          }
        } else if (op === 'trialclose') {
          const a = Math.round(rand() * total * 0.7 * 30) / 30
          const b = Math.min(total, Math.round((a + 4 + rand() * total * 0.4) * 30) / 30)
          const o: RangedEditOptions = {
            steps: {
              cut: true,
              angles: rand() < 0.7,
              speech: rand() < 0.8,
              effects: true,
              se: rand() < 0.7,
              cg: true,
              bgm: rand() < 0.5
            },
            keepLength: rand() < 0.5,
            keepInside: rand() < 0.5,
            lockAfter: rand() < 0.25
          }
          const rv = await usePipelineStore
            .getState()
            .prepareRangedVariants({ start: a, end: b }, o, { exact: rand() < 0.3 })
          if (!rv.ok) {
            log.push(`trial ${a.toFixed(2)}-${b.toFixed(2)} refused`)
            continue
          }
          const list = rv.previews
          const base = project()
          const ps0 = usePipelineStore.getState()
          const snap0 = {
            json: JSON.stringify(base),
            future: useProjectStore.getState().future.length,
            past: useProjectStore.getState().past.length,
            runs: JSON.stringify(ps0.rangeRuns),
            touched: JSON.stringify(ps0.keepTouched),
            kept: JSON.stringify(ps0.roughCut?.keptIds),
            built: JSON.stringify(ps0.builtKept),
            auto: JSON.stringify(base.autoEdit)
          }
          const n = 1 + Math.floor(rand() * 3)
          const seq: string[] = []
          for (let k = 0; k < n; k++) {
            const p2 = pick(list)
            const r = usePipelineStore.getState().tryRangedVariant(p2, list)
            if (!r.ok) fail('trial refused ' + r.reason)
            seq.push(p2.variant.id)
            // 試している間の取り消しは効かない
            if (rand() < 0.15) {
              useProjectStore.getState().undo()
              seq.push('u')
            }
          }
          usePipelineStore.getState().cancelRangedTrial()
          log.push(`trialclose ${a.toFixed(2)}-${b.toFixed(2)} [${seq.join(',')}]`)
          if (JSON.stringify(project()) !== snap0.json) fail('trial close not exact')
          if (useProjectStore.getState().future.length !== snap0.future)
            fail('trial close future differs')
          const ps1 = usePipelineStore.getState()
          if (useProjectStore.getState().past.length !== snap0.past)
            fail('trial close past differs')
          if (JSON.stringify(ps1.rangeRuns) !== snap0.runs)
            fail('!!T rangeRuns differ after trial close')
          if (JSON.stringify(ps1.keepTouched) !== snap0.touched)
            fail('!!T keepTouched differ after trial close')
          if (JSON.stringify(ps1.roughCut?.keptIds) !== snap0.kept)
            fail('~~T roughCut.keptIds differ after trial close')
          if (JSON.stringify(ps1.builtKept) !== snap0.built)
            fail('~~T builtKept differ after trial close')
          if (JSON.stringify(project().autoEdit) !== snap0.auto)
            fail('~~T autoEdit JSON differ after trial close')
        } else if (op === 'lock') {
          const a = rand() * total * 0.7
          const b = Math.min(total, a + 3 + rand() * total * 0.3)
          const cw = commonWindowOf(p.clips, p.multicam!, { start: a, end: b })
          if (cw.ok) {
            useProjectStore.getState().addAutoEditLock(cw.window)
            log.push(`lock ${cw.window.start.toFixed(2)}-${cw.window.end.toFixed(2)}`)
          }
        } else if (op === 'unlock' && (p.autoEditLocks ?? []).length > 0) {
          const l = pick(p.autoEditLocks!)
          useProjectStore.getState().removeAutoEditLock(l.id)
          log.push(`unlock ${l.start.toFixed(2)}-${l.end.toFixed(2)}`)
        } else if (op === 'target') {
          usePipelineStore.getState().setTargetMinutes(pick([0.5, 1, 1.5, 3]))
          log.push(`target ${usePipelineStore.getState().targetMinutes}`)
        } else if (op === 'rebuild') {
          const before = project()
          const mem = memory(before)
          const locks = before.autoEditLocks ?? []
          const lockCov = locks.map((l) => ({
            l,
            segs: inter(cov(before), [l])
          }))
          await usePipelineStore.getState().rebuildRoughCut()
          const now = project()
          log.push(`rebuild (locks ${locks.length})`)
          {
            const ovl = (pp: typeof before) => {
              const sp = pp.textOverlays
                .filter((x) => x.utteranceId)
                .sort((a, b) => a.startTime - b.startTime)
              let n = 0
              for (let i = 0; i < sp.length; i++)
                for (let j = i + 1; j < sp.length && sp[j].startTime < sp[i].endTime - 0.05; j++)
                  if (sp[j].utteranceId === sp[i].utteranceId) n++
              return n
            }
            const a0 = ovl(before),
              a1 = ovl(now)
            const v0 = voiceOverlap(before),
              v1 = voiceOverlap(now)
            if (v1.length > v0.length)
              log.push(
                `  !!H voice overlap after rebuild ${v0.length}->${v1.length} ${v1.slice(0, 3).join(' ')}`
              )
            if (a1 > a0) {
              log.push(
                `  !!F same-utterance overlap after rebuild ${a0}->${a1} locks=${locks.length}`
              )
              const sp = now.textOverlays
                .filter((x) => x.utteranceId)
                .sort((a, b) => a.startTime - b.startTime)
              for (let i = 0; i < sp.length; i++)
                for (let j = i + 1; j < sp.length && sp[j].startTime < sp[i].endTime - 0.05; j++)
                  if (sp[j].utteranceId === sp[i].utteranceId)
                    log.push(
                      `    F ${sp[i].text.replace(/\n/g, '').slice(0, 14)} [${sp[i].startTime.toFixed(2)}-${sp[i].endTime.toFixed(2)}] [${sp[j].startTime.toFixed(2)}-${sp[j].endTime.toFixed(2)}] lockTW=${locks
                        .map((l) => {
                          const w = timelineWindowOf(now.clips, now.multicam!, l)
                          return w ? w.start.toFixed(2) + '-' + w.end.toFixed(2) : 'null'
                        })
                        .join(',')}`
                    )
            }
          }
          const c = cov(now)
          const revived = len(inter(subtractRanges(unionRanges(mem.removed), cov(before)), c))
          if (revived > 0.1)
            fail(
              `hand-removed revived ${revived.toFixed(2)} removed=${fmtSegs(mem.removed as CameraSeg[])}\nlocks=${JSON.stringify(locks)}\nbefore=${fmtSegs(cov(before))}\nauto=${fmtSegs(before.roughCutAuto ?? [])}\nover=${JSON.stringify(before.cutOverrides)}\nafter=${fmtSegs(c)}\nafterAuto=${fmtSegs(now.roughCutAuto ?? [])}`
            )
          // 手で替えたカメラ(まだ映っている所)
          let angleLost = 0
          const cb = cov(before)
          const realAngles = mem.angles.flatMap((a) =>
            cb
              .filter((s) => s.cameraId === a.cameraId)
              .map((s) => ({
                start: Math.max(a.start, s.start),
                end: Math.min(a.end, s.end),
                cameraId: a.cameraId
              }))
              .filter((x) => x.end > x.start)
          )
          // 同じ時刻を複製で2回映すときは、どれかの複製に手で決めたカメラが残っていれば失っていない
          // (ロックの中の複製は、カメラを1つに潰さずにそのまま差し戻す)
          for (const a of realAngles) {
            const shown = inter(c, [a])
            const kept = inter(
              c.filter((s) => s.cameraId === a.cameraId),
              [a]
            )
            angleLost += len(subtractRanges(shown, kept))
          }
          if (angleLost > 0.1)
            fail(
              `hand angle lost ${angleLost.toFixed(2)} angles=${fmtSegs(mem.angles)}\nlocks=${JSON.stringify(locks)}\nbefore=${fmtSegs(cov(before))}\nauto=${fmtSegs(before.roughCutAuto ?? [])}\nover=${JSON.stringify(before.cutOverrides)}\nafter=${fmtSegs(c)}`
            )
          // ロックの中の発言テロップの時刻は、塊ごとに変わらない(続かないロックも。離れた塊は置かれた所へずれるだけ)
          for (const { l } of lockCov)
            for (const { prev: tw, now: tn } of matchLockBlocks(
              before.clips,
              now.clips,
              now.multicam!,
              l
            )) {
              const rel = (pp: typeof before, w: { start: number; end: number }) =>
                unionRanges(
                  pp.textOverlays
                    .filter((x) => x.utteranceId)
                    .map((x) => ({
                      start: Math.max(w.start, x.startTime) - w.start,
                      end: Math.min(w.end, x.endTime) - w.start
                    }))
                    .filter((x) => x.end > x.start + 1e-6)
                )
              const r0 = rel(before, tw),
                r1 = rel(now, tn)
              const d = len(subtractRanges(r0, r1)) + len(subtractRanges(r1, r0))
              if (d > 0.05) log.push(`  !!L speech telop time inside lock changed ${d.toFixed(2)}`)
            }
          for (const { l, segs } of lockCov) {
            const segsNow = inter(c, [l])
            const diff = len(subtractRanges(segs, segsNow)) + len(subtractRanges(segsNow, segs))
            if (diff > 0.05)
              fail(`lock content changed ${diff.toFixed(2)} lock ${l.start}-${l.end}`)
            // 塊ごと(続かないロックも): 前の塊がみな同じ中身(時刻・カメラの並び)で残り、塊でない中身は増えない
            const blocks0 = timelineBlocksOf(before.clips, before.multicam!, l)
            const pairs = matchLockBlocks(before.clips, now.clips, now.multicam!, l)
            if (pairs.length !== blocks0.length)
              fail(
                `lock block lost ${blocks0.length}->${pairs.length} lock ${l.start}-${l.end}\nbefore=${fmtSegs(cov(before))}\nafter=${fmtSegs(c)}`
              )
            const nowLen = timelineBlocksOf(now.clips, now.multicam!, l).reduce(
              (t, b) => t + b.end - b.start,
              0
            )
            const pairLen = pairs.reduce((t, x) => t + x.now.end - x.now.start, 0)
            if (Math.abs(nowLen - pairLen) > 0.05)
              fail(`lock content added ${(nowLen - pairLen).toFixed(2)} lock ${l.start}-${l.end}`)
          }
          // 作り直した直後は、人の手直しの記憶と組んだ本編が合う(作り直しの結果を手直しと誤認しない)
          const m2 = memory(now)
          const extraRem = len(subtractRanges(unionRanges(m2.removed), unionRanges(mem.removed)))
          if (extraRem > 0.1)
            log.push(`  !! new removed memory after rebuild ${extraRem.toFixed(2)}`)
        } else if (op === 'undo') {
          useProjectStore.getState().undo()
          log.push('undo')
        } else if (op === 'redo') {
          useProjectStore.getState().redo()
          log.push('redo')
        }
        {
          const m = memory()
          const st = len(inter(m.removed, cov()))
          if (st > 0.05) log.push(`  stale removed memory ${st.toFixed(2)} after ${op}`)
        }
      }
      const warn = log.filter((l) => l.includes('!!') || l.includes('stale'))
      if (warn.length || process.env.VERBOSE) console.log(`seed ${seed0}:\n` + log.join('\n'))
    })
})
