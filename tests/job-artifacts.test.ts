// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJob } from '@shared/ipc'
import { JobArtifacts } from '../src/renderer/src/ui/JobArtifacts'
import { usePanelStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'

const job = (artifacts?: string[], cwd = '/jobs/j1'): AgentJob =>
  ({ id: 'j1', title: '競合サービスの調査', cwd, status: 'done', engine: 'codex', prompt: '', readonly: false, startedAt: 1, artifacts }) as AgentJob

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.assign(window, { api: { panelFetch: vi.fn(async () => ({ props: {}, source: '' })) } })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'jobs' })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('JobArtifacts', () => {
  it('shows nothing for a job that left no file', () => {
    act(() => root.render(React.createElement(JobArtifacts, { job: job() })))
    expect(host.innerHTML).toBe('')
  })

  it('names each file with its kind and its folder inside the job, and opens them all with the pressed one selected', async () => {
    const paths = ['/jobs/j1/report.md', '/jobs/j1/notes/interview.md', '/elsewhere/pricing.csv']
    act(() => root.render(React.createElement(JobArtifacts, { job: job(paths) })))
    const cards = [...host.querySelectorAll('li')]
    expect(cards.map((card) => card.querySelector('.ja-name')?.textContent)).toEqual(['report.md', 'interview.md', 'pricing.csv'])
    expect(cards[0].querySelector('.ja-meta')?.textContent).not.toContain('·')
    expect(cards[1].querySelector('.ja-meta')?.textContent).toContain('notes')
    expect(cards[2].querySelector('.ja-meta')?.textContent).toContain('/elsewhere')

    await act(async () => cards[1].querySelector('button')!.click())
    expect(window.api.panelFetch).toHaveBeenCalledWith('files', { paths, title: '競合サービスの調査', selected: 1 })
    expect(usePanelStore.getState().panels.some((panel) => panel.type === 'files')).toBe(true)
    expect(useViewStore.getState().open?.app).not.toBe('jobs')
  })

  it('names the files of a job on Windows by their own name and their folder inside the job', () => {
    const paths = ['C:\\jobs\\j1\\report.md', 'C:/jobs/j1/notes/interview.md', 'C:\\jobs\\j1-old\\pricing.csv']
    act(() => root.render(React.createElement(JobArtifacts, { job: job(paths, 'C:\\jobs\\j1') })))
    const cards = [...host.querySelectorAll('li')]
    expect(cards.map((card) => card.querySelector('.ja-name')?.textContent)).toEqual(['report.md', 'interview.md', 'pricing.csv'])
    expect(cards[0].querySelector('.ja-meta')?.textContent).not.toContain('·')
    expect(cards[1].querySelector('.ja-meta')?.textContent).toMatch(/· notes$/)
    expect(cards[2].querySelector('.ja-meta')?.textContent).toMatch(/· C:\\jobs\\j1-old$/)
  })
})
