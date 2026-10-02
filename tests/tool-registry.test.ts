import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CalendarEventDetail } from '@shared/calendar'
import {
  STOP_GRACE_MS,
  ToolError,
  bilingual,
  createToolRegistry,
  executeTool,
  formatToolResult,
  inputJsonSchema,
  operationStarted,
  renderToolGuide,
  resolvePromptTexts,
  truncateMiddle,
  type ToolDefinition
} from '@shared/tool-registry'

type Ctx = { calls: string[] }

const def = (partial: Partial<ToolDefinition<Ctx>> & Pick<ToolDefinition<Ctx>, 'name' | 'run'>): ToolDefinition<Ctx> => ({
  description: { ja: `${partial.name} のツール`, en: `${partial.name} tool` },
  inputSchema: { type: 'object', properties: {} },
  parallel: true,
  timeoutMs: 1000,
  maxResultChars: 500,
  ...partial
})

describe('truncateMiddle', () => {
  it('returns the text unchanged when it fits the limit', () => {
    expect(truncateMiddle('abc', 10, 'ja')).toEqual({ text: 'abc', truncated: false })
  })

  it('drops the middle, keeps the head and the tail, and states the original length on the first line', () => {
    const text = 'A'.repeat(100) + 'B'.repeat(100)
    const result = truncateMiddle(text, 80, 'ja')
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('[元は200文字、途中を省略]\n')).toBe(true)
    expect(result.text).toContain('\n…\n')
    expect(result.text.length).toBeLessThanOrEqual(80)
    expect(result.text.endsWith('B')).toBe(true)
    expect(result.text.split('\n')[1].startsWith('A')).toBe(true)
  })
})

describe('formatToolResult', () => {
  it('drops the middle of a string that exceeds the limit', () => {
    const result = formatToolResult('x'.repeat(50), 30, 'ja')
    expect(result.truncated).toBe(true)
    expect(result.resultLength).toBe(50)
    expect(result.content.length).toBeLessThanOrEqual(30)
  })

  it('serializes an object that fits the limit as plain JSON', () => {
    const result = formatToolResult({ shown: true, items: [1, 2, 3] }, 100, 'ja')
    expect(result).toMatchObject({ content: '{"shown":true,"items":[1,2,3]}', truncated: false, resultLength: 30 })
  })

  it('cuts an array by element count, states how many were dropped, and stays parseable as JSON', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}` }))
    const result = formatToolResult({ items }, 800, 'ja')
    expect(result.truncated).toBe(true)
    const [header, body] = result.content.split('\n')
    expect(header).toContain('元は')
    const parsed = JSON.parse(body) as { items: unknown[] }
    expect(parsed.items.length).toBeLessThan(60)
    expect(parsed.items.at(-1)).toMatch(/^…他\d+件を省略$/)
    expect(parsed.items[0]).toEqual({ id: 0, name: 'item-0' })
    expect(result.content.length).toBeLessThanOrEqual(800)
  })

  it('truncates the tail of a long string leaf and appends its original length', () => {
    const result = formatToolResult({ summary: 'あ'.repeat(1000), title: 't' }, 300, 'ja')
    const parsed = JSON.parse(result.content.split('\n')[1]) as { summary: string; title: string }
    expect(parsed.title).toBe('t')
    expect(parsed.summary).toMatch(/…\(元は1000文字\)$/)
  })

  it('keeps as much of a long body as the limit allows, counting the line that says it was cut, and leaves the short strings beside it whole', () => {
    const note = { id: 'n1', title: '議事録', markdown: 'あ'.repeat(13_000) }
    const result = formatToolResult(note, 12_000, 'ja')
    const shown = JSON.parse(result.content.split('\n')[1]) as typeof note
    expect(result.content.length).toBeLessThanOrEqual(12_000)
    expect(shown.title).toBe('議事録')
    // A body cut far below the limit would leave the model reading a fraction of what fits.
    expect(shown.markdown.length).toBeGreaterThan(11_500)
  })

  it('shares the limit between several long strings, cutting each to the same length', () => {
    const value = { a: 'a'.repeat(5000), b: 'b'.repeat(5000), c: 'c'.repeat(100) }
    const result = formatToolResult(value, 6000, 'en')
    const shown = JSON.parse(result.content.split('\n')[1]) as typeof value
    expect(result.content.length).toBeLessThanOrEqual(6000)
    expect(shown.c).toBe(value.c)
    expect(shown.a.length).toBe(shown.b.length)
    expect(shown.a.length).toBeGreaterThan(2500)
  })

  it('keeps fewer items rather than cutting the ids of a long list with several long fields', () => {
    // The events of a shared calendar as show_calendar returns them, whose ids are long.
    const events: CalendarEventDetail[] = Array.from({ length: 30 }, (_, i) => ({
      id: `${String(i).padStart(3, '0')}${'e'.repeat(116)}`,
      title: `定例会議 ${i}`,
      date: '2026-10-02(金)',
      time: '10:00–11:00',
      location: '会'.repeat(120),
      calendar: 'team-calendar@group.calendar.google.com',
      start: '2026-10-02T10:00:00+09:00',
      end: '2026-10-02T11:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      allDay: false,
      notes: 'メ'.repeat(600),
      recurring: false,
      hasAttendees: false,
      writable: true
    }))
    const result = formatToolResult({ today: '2026-10-02(金)', range: '2026-10-02(金)〜2026-10-08(木)', count: events.length, events }, 12_000, 'ja')
    const shown = (JSON.parse(result.content.split('\n')[1]) as { events: unknown[] }).events.filter((event) => typeof event === 'object') as CalendarEventDetail[]
    expect(result.content.length).toBeLessThanOrEqual(12_000)
    expect(shown.length).toBeGreaterThan(0)
    // An event whose id was cut cannot be changed or deleted.
    expect(shown.map((event) => event.id)).toEqual(events.slice(0, shown.length).map((event) => event.id))
  })

  it('throws when shrinking still does not fit, rather than returning broken JSON', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 200; i++) wide[`key-${i}`] = i
    expect(() => formatToolResult(wide, 100, 'ja')).toThrow(ToolError)
  })
})

describe('renderToolGuide', () => {
  it('builds the guide section from the usage sentence registered with each tool', () => {
    const entries = [
      { name: 'a', usage: { ja: 'いつ使うか', en: 'when to use it' } },
      { name: 'b', usage: { ja: 'こういうとき', en: 'in this case' } }
    ]
    expect(renderToolGuide(entries, 'ja')).toBe('# ツールの使い分け\n- a: いつ使うか\n- b: こういうとき')
    expect(renderToolGuide(entries, 'en')).toBe(
      '# Choosing between the tools\n- a: when to use it\n- b: in this case'
    )
  })
})

describe('inputJsonSchema', () => {
  it('lets the model leave out a field with a default, and still tells it to write no key the schema does not list', () => {
    const schema = inputJsonSchema(
      z.object({ place: z.string(), mode: z.enum(['place', 'search']).default('place'), origin: z.object({ name: z.string() }).optional() })
    )
    expect(schema.required).toEqual(['place'])
    expect(schema.additionalProperties).toBe(false)
    expect((schema.properties as Record<string, { additionalProperties?: unknown }>).origin.additionalProperties).toBe(false)
  })
})

describe('createToolRegistry', () => {
  it('rejects two definitions that share a name', () => {
    const a = def({ name: 'a', run: () => 1 })
    expect(() => createToolRegistry([a, a])).toThrow('duplicate')
  })

  it('builds the tool specs in the order the definitions were registered', () => {
    const registry = createToolRegistry([def({ name: 'a', run: () => 1 }), def({ name: 'b', run: () => 2 })])
    expect(registry.toolSpecs('ja').map((t) => t.name)).toEqual(['a', 'b'])
    expect(registry.toolSpecs('en')[0]).toEqual({
      name: 'a',
      description: 'a tool',
      inputSchema: { type: 'object', properties: {} }
    })
    expect(registry.toolSpecs('ja')[0].description).toBe('a のツール')
    expect(registry.find('b')?.name).toBe('b')
    expect(registry.find('c')).toBeUndefined()
  })
})

describe('executeTool', () => {
  const ctx: Ctx = { calls: [] }
  const signal = new AbortController().signal

  it('turns a successful result into a string within the limit', async () => {
    const registry = createToolRegistry([def({ name: 'echo', run: (input) => ({ got: input.x }) })])
    const result = await executeTool(registry, 'echo', { x: 1 }, ctx, signal, 'ja')
    expect(result).toMatchObject({ content: '{"got":1}', isError: false, truncated: false, resultLength: 9 })
  })

  it('passes text from outside through as it is, even text that looks like a packed pair', async () => {
    const subjects = ['bilingual: 請求書', bilingual({ ja: '請求書について', en: 'About the invoice' }), 'Re: 見積もりの件']
    const registry = createToolRegistry([
      def({ name: 'list_mail', run: () => ({ messages: subjects.map((subject) => ({ subject })) }) }),
      def({ name: 'read_mail', run: () => { throw new Error(subjects[0]) } })
    ])
    const listed = await executeTool(registry, 'list_mail', {}, ctx, signal, 'ja')
    expect(listed.isError).toBe(false)
    expect(JSON.parse(listed.content)).toEqual({ messages: subjects.map((subject) => ({ subject })) })
    const failed = await executeTool(registry, 'read_mail', {}, ctx, signal, 'ja')
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain(subjects[0])
  })

  it('returns a failed result for an unregistered tool instead of throwing', async () => {
    const registry = createToolRegistry([])
    const result = await executeTool(registry, 'nope', {}, ctx, signal, 'ja')
    expect(result.isError).toBe(true)
    expect(result.content).toContain('nope')
  })

  it('passes a ToolError message through and wraps any other exception with the failure and how to fix it', async () => {
    const registry = createToolRegistry([
      def({ name: 'tool-error', run: () => { throw new ToolError({ ja: '入力が不正: xを指定すること', en: 'Invalid input: give x' }) } }),
      def({ name: 'crash', run: () => { throw new Error('ECONNREFUSED') } })
    ])
    const a = await executeTool(registry, 'tool-error', {}, ctx, signal, 'ja')
    expect(a).toMatchObject({ isError: true, content: '入力が不正: xを指定すること' })
    const b = await executeTool(registry, 'crash', {}, ctx, signal, 'ja')
    expect(b.isError).toBe(true)
    expect(b.content).toContain('ECONNREFUSED')
    expect(b.content).toContain('crash')
  })

  it('returns a timeout failure past the time limit and aborts the signal it handed to the tool', async () => {
    let seen: AbortSignal | null = null
    const registry = createToolRegistry([
      def({
        name: 'slow',
        timeoutMs: 20,
        run: (_input, _ctx, s) =>
          new Promise((resolve) => {
            seen = s
            setTimeout(() => resolve('late'), 200)
          })
      })
    ])
    const result = await executeTool(registry, 'slow', {}, ctx, signal, 'ja')
    expect(result.isError).toBe(true)
    expect(result.content).toContain('時間切れ')
    expect(result.content).toContain('slow')
    await new Promise((r) => setTimeout(r, 30))
    expect(seen!.aborted).toBe(true)
  })

  it('gives an operation that started late in the time limit a limit of its own, and says it started when that one passes too', async () => {
    vi.useFakeTimers()
    try {
      let approve!: () => void
      const approval = new Promise<void>((resolve) => { approve = resolve })
      let finishSend!: () => void
      const registry = createToolRegistry([
        def({ name: 'send', timeoutMs: 1000, run: async (_input, _ctx, s) => { await approval; operationStarted(s); await new Promise<void>((resolve) => { finishSend = resolve }); return 'sent' } }),
        def({ name: 'archive', timeoutMs: 1000, run: async (_input, _ctx, s) => { await approval; operationStarted(s); await new Promise(() => {}) } })
      ])
      const sent = executeTool(registry, 'send', {}, ctx, signal, 'ja')
      const archived = executeTool(registry, 'archive', {}, ctx, signal, 'ja')
      await vi.advanceTimersByTimeAsync(900)
      approve()
      await vi.advanceTimersByTimeAsync(500)
      finishSend()
      expect(await sent).toMatchObject({ isError: false, content: 'sent' })
      await vi.advanceTimersByTimeAsync(1000)
      const cut = await archived
      expect(cut).toMatchObject({ isError: true, unfinished: true })
      expect(cut.content).toContain('archive')
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the model that an operation the caller cut off after it started may have happened, and one cut off before it did not', async () => {
    const begun = new AbortController()
    const waiting = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    // Both go on past their abort until the test ends them, as a write that has started does.
    let finish!: () => void
    const work = new Promise<string>((resolve) => { finish = () => resolve('done') })
    const registry = createToolRegistry([
      def({ name: 'write', run: (_input, _ctx, s) => { started(); operationStarted(s); return work } }),
      def({ name: 'wait', run: () => work })
    ])
    const written = executeTool(registry, 'write', {}, ctx, begun.signal, 'ja')
    const waited = executeTool(registry, 'wait', {}, ctx, waiting.signal, 'ja')
    await ready
    begun.abort()
    waiting.abort()
    expect(await written).toMatchObject({ isError: true, unfinished: true })
    const interrupted = await waited
    expect(interrupted.isError).toBe(true)
    expect(interrupted.unfinished).toBeUndefined()
    finish()
    await Promise.all([written.completion, waited.completion])
  })

  it('keeps waiting for a tool that timed out until it stops, and gives up on one that ignores its abort after the grace, saying so', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let finishCleanup!: () => void
      const registry = createToolRegistry([
        def({ name: 'cleanup', run: () => new Promise((resolve) => (finishCleanup = () => resolve('done'))) }),
        def({ name: 'stuck', run: () => new Promise(() => {}) })
      ])
      const ended: string[] = []
      const cleanup = executeTool(registry, 'cleanup', {}, ctx, signal, 'ja')
      const stuck = executeTool(registry, 'stuck', {}, ctx, signal, 'ja')
      void cleanup.completion.then(() => ended.push('cleanup'))
      void stuck.completion.then(() => ended.push('stuck'))
      await vi.advanceTimersByTimeAsync(1000)
      expect((await cleanup).isError).toBe(true)
      expect((await stuck).isError).toBe(true)
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1)
      expect(ended).toEqual([])
      finishCleanup()
      await vi.advanceTimersByTimeAsync(1)
      expect(ended).toEqual(['cleanup', 'stuck'])
      expect(errors).toHaveBeenCalledOnce()
      expect(String(errors.mock.calls[0][0])).toContain('stuck')
    } finally {
      errors.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reports the result as interrupted when the caller aborts', async () => {
    const controller = new AbortController()
    const registry = createToolRegistry([
      def({
        name: 'fetch',
        run: (_input, _ctx, s) =>
          new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))))
      })
    ])
    const pending = executeTool(registry, 'fetch', {}, ctx, controller.signal, 'ja')
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('中断')
  })

  it('measures how long the tool took', async () => {
    let t = 1000
    const now = vi.fn(() => t)
    const registry = createToolRegistry([
      def({
        name: 'tick',
        run: () => {
          t += 250
          return 'ok'
        }
      })
    ])
    const result = await executeTool(registry, 'tick', {}, ctx, signal, 'ja', now)
    expect(result.durationMs).toBe(250)
  })

  it('returns a failure for a result too large to shrink', async () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 200; i++) wide[`key-${i}`] = i
    const registry = createToolRegistry([def({ name: 'wide', maxResultChars: 100, run: () => wide })])
    const result = await executeTool(registry, 'wide', {}, ctx, signal, 'ja')
    expect(result.isError).toBe(true)
    expect(result.content).toContain('大きすぎて')
  })
})
