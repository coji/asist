import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, executeTool, type ToolExecution, type ToolExecutionTask } from '@shared/tool-registry'
import {
  ToolRoundExecutor,
  buildToolResultsMessage,
  lastRoundNote,
  type ToolUseCall
} from '@shared/tool-round'

const exec = (content: string, isError = false): ToolExecution => ({
  content,
  isError,
  durationMs: 0,
  resultLength: content.length,
  truncated: false
})

const call = (id: string, name: string): ToolUseCall => ({ id, name, input: {} })
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const task = (result: Promise<ToolExecution>): ToolExecutionTask =>
  Object.assign(result, { completion: result.then(() => undefined, () => undefined) })

/** A fake execution whose per-name duration decides the order in which the calls finish. */
function harness(durations: Record<string, number>, signal = new AbortController().signal) {
  const started: string[] = []
  const finished: string[] = []
  const executor = new ToolRoundExecutor({
    signal,
    locale: 'ja-JP',
    isParallel: (name) => !name.startsWith('write'),
    execute: (c) => task((async () => {
      started.push(c.id)
      await wait(durations[c.name] ?? 1)
      finished.push(c.id)
      return exec(`result:${c.id}`)
    })())
  })
  return { executor, started, finished }
}

describe('ToolRoundExecutor', () => {
  it('runs read-only tools concurrently and orders the results by submission', async () => {
    const { executor, finished } = harness({ slow: 40, fast: 5 })
    executor.submit(call('a', 'slow'))
    executor.submit(call('b', 'fast'))
    const results = await executor.settle()
    expect(finished).toEqual(['b', 'a'])
    expect(results.map((r) => r.call.id)).toEqual(['a', 'b'])
    expect(results.map((r) => r.execution.content)).toEqual(['result:a', 'result:b'])
  })

  it('synthesizes an interrupted result for every tool that had not started when the round was aborted', async () => {
    const controller = new AbortController()
    const { executor, started } = harness({ slow: 30 }, controller.signal)
    executor.submit(call('a', 'slow'))
    executor.submit(call('b', 'write'))
    await wait(5)
    controller.abort()
    const results = await executor.settle()
    expect(started).toEqual(['a'])
    expect(results[1].execution.isError).toBe(true)
    expect(results[1].execution.content).toContain('中断')
    expect(results).toHaveLength(2)
  })

  it('calls onStart and onFinish', async () => {
    const events: string[] = []
    const executor = new ToolRoundExecutor({
      signal: new AbortController().signal,
      isParallel: () => true,
      execute: (c) => task(Promise.resolve(exec(`r:${c.id}`))),
      onStart: (c) => events.push(`start:${c.id}`),
      onFinish: (r) => events.push(`finish:${r.call.id}:${r.execution.content}`)
    })
    executor.submit(call('x', 'read'))
    await executor.settle()
    expect(events).toEqual(['start:x', 'finish:x:r:x'])
  })

  it('calls onFinish for a tool that was running when the round was aborted, and not for one that never started', async () => {
    const controller = new AbortController()
    const finished: string[] = []
    const executor = new ToolRoundExecutor({
      signal: controller.signal,
      locale: 'ja-JP',
      isParallel: (name) => name !== 'write',
      execute: (c, signal) => task(new Promise((resolve) => signal.addEventListener('abort', () => resolve(exec(`stopped:${c.id}`, true)), { once: true }))),
      onFinish: (r) => finished.push(`${r.call.id}:${r.execution.content}`)
    })
    executor.submit(call('a', 'read'))
    executor.submit(call('b', 'write'))
    await wait(5)
    controller.abort()
    await executor.settle()
    expect(finished).toEqual(['a:stopped:a'])
  })

  it('does not start a later writing tool while an earlier one is still working, even after its response timed out', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const started: string[] = []
    const registry = createToolRegistry(['read', 'write'].map((name) => ({
      name, description: { ja: name, en: name }, inputSchema: { type: 'object' as const, properties: {} },
      parallel: name === 'read', timeoutMs: 10, maxResultChars: 500,
      run: () => {
        started.push(name)
        return name === 'read' ? new Promise<string>((resolve) => { finish = resolve }) : 'written'
      }
    })))
    const executor = new ToolRoundExecutor({
      signal: new AbortController().signal,
      isParallel: (name) => registry.find(name)!.parallel,
      execute: (call, signal) => executeTool(registry, call.name, call.input, {}, signal, 'ja')
    })
    try {
      const first = executor.submit(call('first', 'read'))
      const second = executor.submit(call('second', 'write'))
      await vi.advanceTimersByTimeAsync(11)
      expect((await first).execution.isError).toBe(true)
      expect(started).toEqual(['read'])
      const closing = executor.close()
      finish('late result')
      await closing
      expect((await second).execution.isError).toBe(true)
      expect(started).toEqual(['read'])
    } finally {
      finish?.('cleanup')
      await executor.close()
      vi.useRealTimers()
    }
  })
})

describe('buildToolResultsMessage', () => {
  const results = [
    { call: call('t1', 'read'), execution: exec('ok') },
    { call: call('t2', 'write'), execution: exec('失敗した', true) }
  ]

  it('orders the results by call, carries each tool name, and marks a failure with isError', () => {
    const message = buildToolResultsMessage(results, { index: 0, maxRounds: 6, locale: 'ja-JP' })
    expect(message).toEqual({
      role: 'user',
      parts: [
        { type: 'tool_result', callId: 't1', name: 'read', content: 'ok' },
        { type: 'tool_result', callId: 't2', name: 'write', content: '失敗した', isError: true }
      ]
    })
  })

  it('appends the note about finishing next time when one round is left before the limit', () => {
    const before = buildToolResultsMessage(results, { index: 3, maxRounds: 6, locale: 'ja-JP' })
    expect(before.parts).toHaveLength(2)
    const last = buildToolResultsMessage(results, { index: 4, maxRounds: 6, locale: 'ja-JP' })
    expect(last.parts).toHaveLength(3)
    expect(last.parts[2]).toEqual({ type: 'text', text: lastRoundNote('ja-JP') })
    expect(lastRoundNote('ja-JP')).toContain('ツールを呼ばず')
  })

  it('does not append the note after a response whose provider-side tool returned no result', () => {
    const message = buildToolResultsMessage(results, { index: 4, maxRounds: 6, allowNote: false, locale: 'ja-JP' })
    expect(message.parts.every((part) => part.type === 'tool_result')).toBe(true)
  })
})
