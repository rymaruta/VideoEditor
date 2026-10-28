/* eslint-disable @typescript-eslint/explicit-function-return-type -- 監査で書いた再現の試験をそのまま取り込んだもの */
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
import { sameProjectContent } from '@renderer/lib/projectEquality'
import { mainLength, type RangedEditOptions } from '@renderer/lib/rangedAutoEdit'
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
import { autoTelopKey } from '@shared/telop/manual'
import { markIn, markOut, rippleDelete } from '@renderer/lib/editCommands'
import {
  cov,
  episode2,
  inter,
  len,
  lockNeighborMismatches,
  lockOrder,
  memory,
  project,
  reversedPairs
} from './h'

/**
 * 範囲の自動編集・ロック・作り直し・手直し(詰め・消す・カメラ・速さ替え・並べ替え・I/O の Shift+Delete)・
 * I/O の範囲・取り消しを乱択で混ぜる監査の試験(7211975・9cb67d8 の監査から)。
 * 常設は種を固定した短い版(監査で見つかった 10・73 を含む)。多く回すときは
 * `SEEDS=1,2,...,300 NSTEPS=40` を付けて走らせる
 */
const SEEDS = (process.env.SEEDS ?? '1,2,3,10,13,29,43,73').split(',').map(Number)
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
          'target'
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
          const r = await usePipelineStore
            .getState()
            .prepareRangedEdit({ start: a, end: b }, o, { exact: op === 'iorange' || rand() < 0.3 })
          if (!r.ok) {
            log.push(`range ${a.toFixed(2)}-${b.toFixed(2)} refused: ${r.reason.slice(0, 30)}`)
            continue
          }
          const pv = r.preview
          const memBefore = memory()
          const base = project()
          const bt = clipTimes(base.clips)
          const outsideBefore = base.clips.filter(
            (_, k) => bt[k].end <= pv.range.start + 1e-6 || bt[k].start >= pv.range.end - 1e-6
          )
          const runs0 = usePipelineStore.getState().rangeRuns.length
          const past0 = useProjectStore.getState().past.length
          if (!usePipelineStore.getState().applyRangedEdit(pv).ok) fail('apply refused')
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
            if (newD.length)
              log.push(
                `  !!D duplicate auto telops after range: ${newD.length} ${newD.slice(0, 3).join(',')}`
              )
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
            log.push(
              `  !!R rangeRuns after undo ${usePipelineStore.getState().rangeRuns.length} vs ${runs0}`
            )
          useProjectStore.getState().redo()
          if (!sameProjectContent({ ...project(), autoEdit: after.autoEdit }, after))
            fail('redo not exact')
          if (usePipelineStore.getState().rangeRuns.length !== runs1)
            log.push(`  !!R rangeRuns after redo`)
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
                  sp[i].text === sp[j].text &&
                  (Math.abs(sp[i].endTime - pv.newRange.start) < 0.02 ||
                    Math.abs(sp[i].endTime - pv.newRange.end) < 0.02)
                )
                  log.push(
                    `  ~~same text consecutive at ${sp[i].endTime.toFixed(2)} (range ${pv.newRange.start.toFixed(2)}-${pv.newRange.end.toFixed(2)})`
                  )
          }
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
          const order0 = lockOrder(before)
          // どちらも元の所の塊が逆の順に並ぶ組(順を保つと、組ごとにどちらかの前後が1つ食い違う)の数
          const reversedCount = reversedPairs(before)
          const nb0 = lockNeighborMismatches(before)
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
          // ロックした塊の、タイムラインの順の中身の並びは変わらない(matchLockBlocks を使わない確かめ)
          if (lockOrder(now) !== order0)
            fail(`lock order changed\nbefore=${order0}\nafter =${lockOrder(now)}`)
          // ロックした塊が、並べ替えたクリップに付いて動かない: 元の所の塊を持つロックは元の所を失わず、
          // 前後の自由な所と食い違う側は、逆の順に並ぶ組の数より増えない
          {
            const nb1 = lockNeighborMismatches(now)
            const lost = [...nb0.inPlace].filter((id) => !nb1.inPlace.has(id))
            if (lost.length > 0)
              fail(`lock left its place ${lost.length}\nbefore=${nb0.detail}\nafter =${nb1.detail}`)
            if (nb1.count - nb0.count > reversedCount)
              fail(
                `lock neighbors mismatched ${nb0.count}->${nb1.count} (reversed pairs ${reversedCount})\nbefore=${nb0.detail}\nafter =${nb1.detail}`
              )
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
      // 同じ鍵の自動テロップが2枚あるだけ(!!D)は失敗にしない: 仮編集でも、カットで分かれた1枚は同じ鍵の
      // 枚になる。時刻が重なる(!!E・!!F)・同じ文が継ぎ目なく続く(~~)は失敗
      const warn = log.filter(
        (l) => (l.includes('!!') && !l.includes('!!D')) || l.includes('stale') || l.includes('~~')
      )
      if (warn.length || process.env.VERBOSE) console.log(`seed ${seed0}:\n` + log.join('\n'))
      expect(warn).toEqual([])
    })
})
