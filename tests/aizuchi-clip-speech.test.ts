import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRecognizer } from '../scripts/aizuchi-clips/speech.mjs'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
// The script runs llama-server and the model files a developer has prepared, which a test machine lacks.
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()), existsSync: () => true }))

const requests: Array<{ url: string; headers: Record<string, string> }> = []

beforeEach(() => {
  requests.length = 0
  mocks.spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { kill: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 })
    requests.push({ url, headers: init?.headers as Record<string, string> })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'language Japanese<asr_text>はい。' } }] }), { status: 200 })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** Starts the recognizer, reads a short silence with it, and returns how the server was started. */
async function startAndRecognize(): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const recognizer = await startRecognizer()
  await expect(recognizer.recognize(new Float32Array(2400))).resolves.toBe('はい。')
  recognizer.stop()
  const [, args, options] = mocks.spawn.mock.calls[0]
  return { args, env: options.env }
}

describe('the llama-server the aizuchi clips are checked with', () => {
  it('keeps the key the requests carry off the server\'s command line, which any user of the machine can read', async () => {
    const { args, env } = await startAndRecognize()
    const key = requests[0].headers.authorization.replace(/^Bearer /, '')
    expect(key).not.toBe('')
    expect(args.some((arg) => arg.includes(key))).toBe(false)
    expect(env.LLAMA_API_KEY).toBe(key)
  })

  it('starts the server without the developer\'s llama.cpp settings, which would move it off the plain HTTP and /health it is reached at', async () => {
    vi.stubEnv('LLAMA_ARG_API_PREFIX', '/llama')
    vi.stubEnv('LLAMA_API_KEY', 'the-developers-own-key')
    const { env } = await startAndRecognize()
    expect(env.LLAMA_ARG_API_PREFIX).toBeUndefined()
    expect(env.LLAMA_API_KEY).not.toBe('the-developers-own-key')
  })
})
