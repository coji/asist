import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  artifactPaths,
  createClaudeStreamParser,
  createCodexStreamParser,
  type AgentStreamEvent
} from '@shared/agent-stream'

/** The fixtures are recorded output of the real CLIs, so a change in their output format shows up here. */
const fixture = (name: string): string[] =>
  fs
    .readFileSync(path.join(__dirname, 'fixtures/agent-stream', name), 'utf8')
    .split('\n')
    .filter((line) => line.trim())

const runAll = (parse: (raw: string) => AgentStreamEvent[], lines: string[]): AgentStreamEvent[] =>
  lines.flatMap((line) => parse(line))

describe('claude -p --output-format stream-json (real output)', () => {
  it('emits Write, a successful Bash, a failed Bash, Read, the reply and result in that order', () => {
    const events = runAll(createClaudeStreamParser(), fixture('claude.jsonl'))
    expect(events).toEqual([
      { kind: 'init', model: 'claude-sonnet-5', sessionId: '6221a88e-f1d4-431e-92cc-7e76b1e50ce8' },
      { kind: 'tool-use', name: 'Write', input: JSON.stringify({ file_path: '/w/hello.txt', content: 'hi' }) },
      { kind: 'file-change', paths: ['/w/hello.txt'] },
      { kind: 'command', id: 'toolu_01N4DEgCL6d9wKM3SATUdhur', command: 'ls', phase: 'start' },
      { kind: 'command', id: 'toolu_01N4DEgCL6d9wKM3SATUdhur', command: 'ls', phase: 'done', ok: true },
      { kind: 'command', id: 'toolu_013C8pBsqsrsV7qexS8QVXYQ', command: 'cat missing.txt', phase: 'start' },
      { kind: 'command', id: 'toolu_013C8pBsqsrsV7qexS8QVXYQ', command: 'cat missing.txt', phase: 'done', ok: false, exitCode: 1 },
      { kind: 'tool-use', name: 'Read', input: JSON.stringify({ file_path: '/w/hello.txt' }) },
      { kind: 'assistant-text', text: 'done' },
      { kind: 'result', ok: true, summary: 'done', numTurns: 5, costUsd: 0.21962980000000001 }
    ])
  })
})

describe('codex exec --json (real output)', () => {
  it('emits file_change, three commands with the second one failing, the reply and result in that order', () => {
    const events = runAll(createCodexStreamParser(), fixture('codex.jsonl'))
    expect(events).toEqual([
      { kind: 'init', model: 'codex', sessionId: '01a0b8d6-ae9a-7902-a540-37b5c19d87f3' },
      { kind: 'assistant-text', text: 'I’ll run those steps in order.' },
      { kind: 'file-change', paths: ['/w/hello.txt'] },
      { kind: 'command', id: 'item_2', command: '/bin/zsh -lc ls', phase: 'start' },
      { kind: 'command', id: 'item_2', command: '/bin/zsh -lc ls', phase: 'done', ok: true, exitCode: 0 },
      { kind: 'command', id: 'item_3', command: "/bin/zsh -lc 'cat missing.txt'", phase: 'start' },
      { kind: 'command', id: 'item_3', command: "/bin/zsh -lc 'cat missing.txt'", phase: 'done', ok: false, exitCode: 1 },
      { kind: 'command', id: 'item_4', command: "/bin/zsh -lc 'cat hello.txt'", phase: 'start' },
      { kind: 'command', id: 'item_4', command: "/bin/zsh -lc 'cat hello.txt'", phase: 'done', ok: true, exitCode: 0 },
      { kind: 'assistant-text', text: 'done' },
      { kind: 'result', ok: true, summary: '' }
    ])
  })
})

describe('individual line shapes of the claude parser', () => {
  it('takes the model name and the session ID from the init event', () => {
    const parse = createClaudeStreamParser()
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 'sess-1' })
    expect(parse(line)).toEqual([{ kind: 'init', model: 'claude-sonnet-5', sessionId: 'sess-1' }])
    expect(parse(JSON.stringify({ type: 'system', subtype: 'init', model: 'x' }))).toEqual([{ kind: 'init', model: 'x' }])
  })

  it('returns the text of an assistant message and its read tool call in order', () => {
    const parse = createClaudeStreamParser()
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: ' 調査を始めます ' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a.ts' } }
        ]
      }
    })
    expect(parse(line)).toEqual([
      { kind: 'assistant-text', text: '調査を始めます' },
      { kind: 'tool-use', name: 'Read', input: '{"file_path":"/tmp/a.ts"}' }
    ])
  })

  it('ignores a tool_result whose tool_use is unknown, and emits no file-change for a failed Write', () => {
    const parse = createClaudeStreamParser()
    expect(parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'zzz' }] } }))).toEqual([])
    parse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Edit', input: { file_path: '/w/a.ts' } }] } }))
    expect(
      parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', is_error: true, content: 'not found' }] } }))
    ).toEqual([])
  })

  it('leaves out exitCode when the text of a failed Bash result carries no exit code', () => {
    const parse = createClaudeStreamParser()
    parse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'x' } }] } }))
    expect(
      parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: [{ type: 'text', text: 'timeout' }] }] } }))
    ).toEqual([{ kind: 'command', id: 'b1', command: 'x', phase: 'done', ok: false }])
  })

  it('reports ok=false for a result with is_error', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, subtype: 'error' })
    expect(createClaudeStreamParser()(line)[0]).toMatchObject({ kind: 'result', ok: false, summary: '' })
  })

  it('turns a line that is not JSON into raw and an unknown type into nothing', () => {
    const parse = createClaudeStreamParser()
    expect(parse('not json')).toEqual([{ kind: 'raw', text: 'not json' }])
    expect(parse(JSON.stringify({ type: 'stream_event' }))).toEqual([])
  })
})

describe('individual line shapes of the codex parser', () => {
  const parse = createCodexStreamParser()

  it('turns a thread.started without a thread_id into init as well', () => {
    expect(parse(JSON.stringify({ type: 'thread.started' }))).toEqual([{ kind: 'init', model: 'codex' }])
  })

  it('emits assistant-text only for a completed agent_message, so the started one does not duplicate it', () => {
    const item = { id: 'i1', type: 'agent_message', text: ' 2 ' }
    expect(parse(JSON.stringify({ type: 'item.completed', item }))).toEqual([{ kind: 'assistant-text', text: '2' }])
    expect(parse(JSON.stringify({ type: 'item.started', item }))).toEqual([])
  })

  it('turns an MCP call and a web search into tool-use', () => {
    const mcp = { id: 'm1', type: 'mcp_tool_call', server: 'github', tool: 'search', arguments: { q: 'x' } }
    expect(parse(JSON.stringify({ type: 'item.completed', item: mcp }))).toEqual([
      { kind: 'tool-use', name: 'github.search', input: '{"q":"x"}' }
    ])
    const search = { id: 's1', type: 'web_search', query: 'electron ipc' }
    expect(parse(JSON.stringify({ type: 'item.completed', item: search }))).toEqual([
      { kind: 'tool-use', name: 'WebSearch', input: '{"query":"electron ipc"}' }
    ])
  })

  it('keeps an error item such as a skill budget notice as raw and does not fail the job', () => {
    const item = { type: 'error', message: 'Skill descriptions were shortened' }
    expect(parse(JSON.stringify({ type: 'item.completed', item }))).toEqual([
      { kind: 'raw', text: 'Skill descriptions were shortened' }
    ])
  })

  it('reports ok=false for turn.failed and takes the error text out of the doubly encoded JSON', () => {
    const inner = JSON.stringify({ type: 'error', status: 400, error: { message: 'model too new' } })
    const line = JSON.stringify({ type: 'turn.failed', error: { message: inner } })
    expect(parse(line)).toEqual([{ kind: 'result', ok: false, summary: 'model too new' }])
  })

  it('keeps a top-level error as raw in the log, because turn.failed decides the status', () => {
    expect(parse(JSON.stringify({ type: 'error', message: 'boom' }))).toEqual([{ kind: 'raw', text: 'boom' }])
  })

  it('emits nothing for turn.started and for unknown types', () => {
    expect(parse(JSON.stringify({ type: 'turn.started' }))).toEqual([])
  })
})

// Each line is parsed in a listener on the CLI's output, where a throw becomes an uncaught exception of the
// main process, so a line of any shape comes out as events.
describe.each([
  ['claude', createClaudeStreamParser],
  ['codex', createCodexStreamParser]
])('the %s parser with a line of an unexpected shape', (_name, create) => {
  it.each(['null', '[1,2]', '"text"', '42'])('turns %s, JSON that is not an object, into raw text like a line that is not JSON', (line) => {
    expect(create()(line)).toEqual([{ kind: 'raw', text: line }])
  })

  it.each([
    { type: 'assistant', message: { content: [null, 5, { type: 'tool_use', id: 't', name: 'Bash', input: null }] } },
    { type: 'system', subtype: 'init', model: { toString: 1, valueOf: 1 } },
    { type: 'item.completed', item: { type: 'file_change', changes: [null, { path: 5 }] } },
    { type: 'item.completed', item: { type: 'command_execution', command: { toString: 1, valueOf: 1 } } }
  ])('does not throw on %j', (value) => {
    const parse = create()
    expect(() => parse(JSON.stringify(value))).not.toThrow()
  })
})

describe('artifactPaths', () => {
  it('keeps only the absolute paths of a file-change and returns nothing for other events', () => {
    expect(artifactPaths({ kind: 'file-change', paths: ['/w/a.md', 'rel.txt'] })).toEqual(['/w/a.md'])
    expect(artifactPaths({ kind: 'tool-use', name: 'Write', input: JSON.stringify({ file_path: '/w/r.md' }) })).toEqual([])
    expect(artifactPaths({ kind: 'command', id: 'c', command: 'x', phase: 'done', ok: true })).toEqual([])
  })

  it('keeps the absolute paths a job reports on Windows, with a drive letter or on a share', () => {
    const paths = ['C:\\Users\\me\\report.md', 'D:/work/chart.png', '\\\\server\\share\\notes.txt', 'rel\\a.md', 'C:rel.md']
    expect(artifactPaths({ kind: 'file-change', paths })).toEqual(paths.slice(0, 3))
  })
})
