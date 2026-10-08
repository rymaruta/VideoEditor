import { describe, expect, it } from 'vitest'
import { withoutStillOverlayFreezes } from '@renderer/store/qcStore'
import type { Project } from '@shared/types'
import type { QcIssue } from '@shared/qc/types'

describe('withoutStillOverlayFreezes — 全面の静止画を出している間の「止まっています」', () => {
  const project = {
    assets: [{ id: 'cg', still: true }],
    videoOverlayTracks: [
      {
        hidden: false,
        position: 'full',
        clips: [{ assetId: 'cg', startTime: 10, inPoint: 0, outPoint: 3 }]
      }
    ]
  } as unknown as Project
  const freeze = (start: number, end: number): QcIssue =>
    ({ kind: 'freeze', start, end, message: '画が止まっています' }) as unknown as QcIssue

  it('静止画の間の指摘は外し、ほかの所の指摘は残す', () => {
    const out = withoutStillOverlayFreezes([freeze(10, 13), freeze(30, 33)], project)
    expect(out.map((i) => i.start)).toEqual([30])
  })

  it('隠したトラック・ワイプの静止画では外さない', () => {
    const hidden = {
      ...project,
      videoOverlayTracks: [{ ...project.videoOverlayTracks[0], hidden: true }]
    } as unknown as Project
    expect(withoutStillOverlayFreezes([freeze(10, 13)], hidden)).toHaveLength(1)
  })
})
