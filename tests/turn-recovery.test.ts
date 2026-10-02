import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '@shared/conversation'
import {
  buildResumeMessages,
  interruptedBeforeReply,
  interruptedWhileSpeaking,
  markInterruptedReply,
  resumeAfterDisconnectNote
} from '@shared/turn-recovery'

const NOTE = resumeAfterDisconnectNote('ja-JP')

describe('markInterruptedReply', () => {
  it('appends the marker to what was spoken, and leaves only the before-reply marker when nothing was', () => {
    expect(markInterruptedReply('ja-JP', '明日は快晴')).toBe(`明日は快晴${interruptedWhileSpeaking('ja-JP')}`)
    expect(markInterruptedReply('ja-JP', '')).toBe(interruptedBeforeReply('ja-JP'))
  })
})

describe('buildResumeMessages', () => {
  const recorded: ConversationMessage = {
    role: 'assistant',
    parts: [
      { type: 'text', text: '調べますね。' },
      { type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } }
    ],
    native: { provider: 'google', model: 'gemini-3.8-flash', payload: { role: 'model', parts: [] } }
  }

  it('keeps the confirmed message as is, answers every tool call, and ends with the request to continue', () => {
    const messages = buildResumeMessages(recorded, [
      {
        call: { id: 't1', name: 'show_weather', input: { location: '大阪' } },
        execution: { content: '{"shown":true}', isError: false, durationMs: 1, resultLength: 14, truncated: false }
      }
    ], NOTE)
    expect(messages).toEqual([
      recorded,
      {
        role: 'user',
        parts: [
          { type: 'tool_result', callId: 't1', name: 'show_weather', content: '{"shown":true}' },
          { type: 'text', text: NOTE }
        ]
      }
    ])
    expect(NOTE).toContain('繰り返さず')
  })

  it('returns an interrupted result with isError', () => {
    const messages = buildResumeMessages(recorded, [
      {
        call: { id: 't1', name: 'show_weather', input: {} },
        execution: { content: '中断された', isError: true, durationMs: 0, resultLength: 5, truncated: false }
      }
    ], NOTE)
    expect(messages[1].parts).toEqual([
      { type: 'tool_result', callId: 't1', name: 'show_weather', content: '中断された', isError: true },
      { type: 'text', text: NOTE }
    ])
  })

  it('throws rather than leave a tool call without a result', () => {
    expect(() => buildResumeMessages(recorded, [], NOTE)).toThrow('t1')
  })

  it('asks to continue without results when the message is text only', () => {
    const messages = buildResumeMessages({ role: 'assistant', parts: [{ type: 'text', text: '途中まで' }] }, [], NOTE)
    expect(messages[1].parts).toEqual([{ type: 'text', text: NOTE }])
  })

  it('leaves out a response that confirmed nothing, whatever provider output it carries, and only asks to continue', () => {
    // A reasoning item alone is what OpenAI keeps of a response whose only tool call the output limit cut off.
    const cut: ConversationMessage = {
      role: 'assistant',
      parts: [],
      native: { provider: 'openai', model: 'gpt-5.5', payload: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' }] }
    }
    expect(buildResumeMessages(cut, [], NOTE)).toEqual([{ role: 'user', parts: [{ type: 'text', text: NOTE }] }])
  })
})
