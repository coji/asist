import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmEvent } from '@shared/confirm'
import { createToolRegistry, executeTool } from '@shared/tool-registry'
import { askingFrom, createConfirmGate } from '../src/main/services/confirm'
import { useConfirmStore } from '../src/renderer/src/state/confirm'

function setup() {
  const events: ConfirmEvent[] = []
  let seq = 0
  const gate = createConfirmGate({ emit: (event) => events.push(event), createId: () => `c${++seq}` })
  return { gate, events }
}

describe('createConfirmGate', () => {
  it('emits open, waits for the answer, then emits close and resolves with the answer', async () => {
    const { gate, events } = setup()
    const pending = gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, new AbortController().signal)
    const request = { id: 'c1', title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false, holdsConversation: false }
    expect(events).toEqual([{ type: 'open', request }])
    expect(gate.pending()).toEqual([request])
    expect(gate.resolve('c1', true)).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(events.at(-1)).toEqual({ type: 'close', id: 'c1' })
    expect(gate.pending()).toEqual([])
    expect(gate.resolve('c1', true)).toBe(false)
  })

  it('closes and resolves false when the caller aborts, and does not open for an already aborted signal', async () => {
    const { gate, events } = setup()
    const controller = new AbortController()
    const pending = gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(events.map((event) => event.type)).toEqual(['open', 'close'])
    await expect(gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, controller.signal)).resolves.toBe(false)
    expect(events).toHaveLength(2)
  })

  it('resolves false when the request is cancelled', async () => {
    const { gate } = setup()
    const pending = gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, new AbortController().signal)
    gate.resolve('c1', false)
    await expect(pending).resolves.toBe(false)
  })

  it('tells the turn a tool asks from before the sheet opens, across the awaits of a service in between, and leaves a screen\'s request alone', async () => {
    const { gate, events } = setup()
    const input = { title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }
    const asked: number[] = []
    const fromTurn = askingFrom(
      () => asked.push(events.length) > 0,
      async () => {
        // The mail and calendar services read their state before they ask.
        await new Promise((resolve) => setTimeout(resolve, 0))
        return gate.request(input, new AbortController().signal)
      }
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(asked).toEqual([0])
    expect(events[0]).toMatchObject({ type: 'open', request: { id: 'c1', holdsConversation: true } })

    const fromScreen = gate.request(input, new AbortController().signal)
    expect(asked).toEqual([0])
    expect(events[1]).toMatchObject({ type: 'open', request: { id: 'c2', holdsConversation: false } })
    gate.resolve('c1', true)
    gate.resolve('c2', true)
    await expect(Promise.all([fromTurn, fromScreen])).resolves.toEqual([true, true])
  })
})

describe('an approval starts the operation of the tool that asked', () => {
  it('has a tool cut off after the user approved reported as started, and one cut off while the sheet was open as interrupted', async () => {
    const { gate } = setup()
    const input = { title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }
    // The operation after the approval goes on past the wait, as a mail operation on a slow server does.
    let finishArchive!: () => void
    const archiving = new Promise<string>((resolve) => { finishArchive = () => resolve('archived') })
    const registry = createToolRegistry([{
      name: 'archive',
      description: { ja: 'archive', en: 'archive' },
      inputSchema: { type: 'object', properties: {} },
      parallel: false,
      timeoutMs: 300_000,
      maxResultChars: 500,
      run: async (_input, _ctx, signal) => ((await gate.request(input, signal)) ? archiving : 'cancelled')
    }])
    const approvedCall = new AbortController()
    const waitingCall = new AbortController()
    const approved = executeTool(registry, 'archive', {}, undefined, approvedCall.signal, 'ja')
    const waiting = executeTool(registry, 'archive', {}, undefined, waitingCall.signal, 'ja')
    await vi.waitFor(() => expect(gate.pending()).toHaveLength(2))
    gate.resolve('c1', true)
    approvedCall.abort()
    waitingCall.abort()
    expect(await approved).toMatchObject({ isError: true, unfinished: true })
    const interrupted = await waiting
    expect(interrupted.isError).toBe(true)
    expect(interrupted.unfinished).toBeUndefined()
    finishArchive()
    await approved.completion
  })
})

describe('the gate wired to the renderer\'s confirmation store', () => {
  beforeEach(() => useConfirmStore.setState({ queue: [] }))

  function wired() {
    let seq = 0
    const store = useConfirmStore.getState
    return createConfirmGate({
      emit: (event) => (event.type === 'open' ? store().open(event.request) : store().close(event.id)),
      createId: () => `c${++seq}`
    })
  }
  const input = { title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }

  it('brings every request main is waiting on to the screen in turn, so that none is left unanswered', async () => {
    const gate = wired()
    // A save from the calendar screen waits with a signal that nothing aborts.
    const fromScreen = gate.request(input, new AbortController().signal)
    const fromTool = gate.request(input, new AbortController().signal)
    expect(useConfirmStore.getState().queue[0]?.id).toBe('c1')
    gate.resolve('c1', true)
    await expect(fromScreen).resolves.toBe(true)
    expect(useConfirmStore.getState().queue[0]?.id).toBe('c2')
    gate.resolve('c2', false)
    await expect(fromTool).resolves.toBe(false)
    expect(useConfirmStore.getState().queue).toEqual([])
    expect(gate.pending()).toEqual([])
  })

  it('puts the requests main still waits on back on a reloaded page once, and the answer given there reaches the caller', async () => {
    const gate = wired()
    const first = gate.request(input, new AbortController().signal)
    const second = gate.request(input, new AbortController().signal)
    // A reload empties the page's queue while main keeps waiting.
    useConfirmStore.setState({ queue: [] })
    // The page listens again before it asks, so a request can reach it both as an event and in the list.
    useConfirmStore.getState().open(gate.pending()[1])
    for (const request of gate.pending()) useConfirmStore.getState().open(request)
    expect(useConfirmStore.getState().queue.map((request) => request.id)).toEqual(['c2', 'c1'])

    gate.resolve('c2', true)
    await expect(second).resolves.toBe(true)
    expect(useConfirmStore.getState().queue.map((request) => request.id)).toEqual(['c1'])
    gate.resolve('c1', false)
    await expect(first).resolves.toBe(false)
    expect(useConfirmStore.getState().queue).toEqual([])
  })

  it('takes a waiting request off the queue when its caller aborts, before it reaches the screen', async () => {
    const gate = wired()
    const shown = gate.request(input, new AbortController().signal)
    const turn = new AbortController()
    const aborted = gate.request(input, turn.signal)
    turn.abort()
    await expect(aborted).resolves.toBe(false)
    gate.resolve('c1', true)
    await expect(shown).resolves.toBe(true)
    expect(useConfirmStore.getState().queue).toEqual([])
  })
})
