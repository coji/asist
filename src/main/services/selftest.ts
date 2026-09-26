import { isJobTerminal } from '@shared/job-status'
import fs from 'node:fs'
import type { AgentJob } from '@shared/ipc'
import * as tts from './tts'
import * as asr from './asr'
import * as aizuchi from './aizuchi'
import * as brain from './brain'
import * as agent from './agent'
import { availableEngines, locateCli, requireCli } from './agent-process/cli-locator'
import { fetchPanel } from './panel-fetchers'
import { providerKey } from './llm'
import type { WeatherData } from '@shared/weather'

/**
 * The self-test, which runs at startup when ASIST_SELFTEST=1. It calls the real services with nothing
 * mocked and checks that the whole pipeline is healthy:
 *
 * - TTS synthesis, WAV decoding and the local speech recognition, the round trip of the voice loop.
 * - Building the aizuchi bank.
 * - A real brain turn: the Claude API, sentence splitting and the TTS segments.
 * - The panel fetcher for the weather.
 * - Detecting the codex and claude CLIs, and running and resuming a job when codex is present.
 */

interface TestResult {
  name: string
  ok: boolean
  detail: string
}

/** Decodes a PCM16 WAV into 16 kHz Float32 samples, resampling linearly when the rate differs. */
function wavToFloat16k(wav: Buffer): Float32Array {
  const sampleRate = wav.readUInt32LE(24)
  const channels = wav.readUInt16LE(22)
  let offset = 12
  let dataStart = -1
  let dataLen = 0
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      dataStart = offset + 8
      dataLen = size
      break
    }
    offset += 8 + size
  }
  if (dataStart < 0) throw new Error('WAV data chunk not found')
  const samples = Math.floor(dataLen / 2 / channels)
  const mono = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    mono[i] = wav.readInt16LE(dataStart + i * 2 * channels) / 32768
  }
  if (sampleRate === 16000) return mono
  const ratio = sampleRate / 16000
  const out = new Float32Array(Math.floor(samples / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const j = Math.floor(pos)
    const frac = pos - j
    out[i] = mono[j] * (1 - frac) + (mono[j + 1] ?? mono[j]) * frac
  }
  return out
}

async function test(
  name: string,
  fn: () => Promise<string>
): Promise<TestResult> {
  try {
    const detail = await fn()
    return { name, ok: true, detail }
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export async function runSelfTest(): Promise<number> {
  console.log('=== ASIST self-test ===')
  const results: TestResult[] = []

  results.push(
    await test('env: ANTHROPIC_API_KEY', async () =>
      providerKey('anthropic') ? 'set' : Promise.reject(new Error('not set'))
    )
  )

  results.push(
    await test('voice loop: TTS→ASR roundtrip', async () => {
      await tts.ensureEngine()
      if (!(await tts.available())) throw new Error('TTS engine not available')
      const synth = await tts.synthesize('こんにちは、音声のテストです')
      if (!synth.audio) throw new Error('TTS returned no audio')
      await asr.ensureServer()
      if (!(await asr.available())) throw new Error('ASR not available')
      const samples = wavToFloat16k(Buffer.from(synth.audio, 'base64'))
      const text = await asr.transcribe(samples)
      if (!/こんにちは|音声|テスト/.test(text)) {
        throw new Error(`transcript mismatch: "${text}"`)
      }
      return `"${text}" (${(samples.length / 16000).toFixed(1)}s)`
    })
  )

  results.push(
    await test('asr: final accuracy under partial load', async () => {
      const synth = await tts.synthesize('明日の東京の天気はどんな感じですか')
      if (!synth.audio) throw new Error('TTS returned no audio')
      const samples = wavToFloat16k(Buffer.from(synth.audio, 'base64'))
      const tail = samples.slice(-16000 * 2)
      const [p1, p2, finalText] = await Promise.all([
        asr.transcribePartial(tail),
        asr.transcribePartial(tail),
        asr.transcribe(samples)
      ])
      if (!/天気/.test(finalText)) throw new Error(`final mismatch: "${finalText}"`)
      return `final="${finalText}" partials=[${p1 ? 'hit' : 'skip'},${p2 ? 'hit' : 'skip'}]`
    })
  )

  results.push(
    await test('aizuchi bank', async () => {
      const bank = await aizuchi.getBank()
      if (bank.length < 10) throw new Error(`only ${bank.length} clips`)
      const withAudio = bank.filter((c) => c.audio).length
      return `${bank.length} clips, ${withAudio} with audio`
    })
  )

  results.push(
    await test('brain: real turn (Claude + segments)', async () => {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('turn timeout (45s)'))
        }, 45000)
        let segments = 0
        let audioSegments = 0
        const handler = (event: import('@shared/ipc').TurnEvent): void => {
          if (event.type === 'segment') {
            segments++
            if (event.segment.audio) audioSegments++
          }
          if (event.type === 'error') {
            cleanup()
            reject(new Error(event.message))
          }
          if (event.type === 'done') {
            cleanup()
            if (!event.fullText || segments === 0) {
              reject(new Error(`no reply (segments=${segments})`))
            } else {
              resolve(`"${event.fullText.slice(0, 40)}…" segments=${segments} audio=${audioSegments}`)
            }
          }
        }
        const cleanup = (): void => {
          clearTimeout(timeout)
          brain.events.off('event', handler)
        }
        brain.events.on('event', handler)
        brain.startTurn('1たす1はいくつ?短く答えて', { aizuchi: 'えっと、' })
      })
    })
  )

  results.push(
    await test('panel: weather(東京都)', async () => {
      const r = await fetchPanel('weather', { location: '東京都', date: 'today' })
      const weather = r.props.weather as WeatherData | undefined
      if (!weather || weather.hourly.length === 0) throw new Error('no hourly forecast')
      const observed = weather.observation?.temperature
      return `${weather.location.name} ${observed ?? '—'}° 観測:${weather.observation?.station ?? 'なし'} 3時間:${weather.hourly.length}件`
    })
  )
  results.push(
    await test('agent: CLI検出', async () => {
      const engines = availableEngines()
      if (engines.length === 0) throw new Error('no agent CLI found (codex/claude)')
      return engines.map((e) => `${e}=${requireCli(e)}`).join(', ')
    })
  )

  if (locateCli('codex').state === 'found') {
    results.push(
      await test('agent: codex実行 + 成果物追跡', async () => {
        const job = agent.start(
          'greeting.txtというファイルを作って、中身は「こんにちは」とだけ書いてください。',
          { title: 'selftest-codex', readonly: false }
        )
        const done = await new Promise<AgentJob>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout(120s)')), 120_000)
          const off = (e: { type: string; job?: AgentJob }): void => {
            if (e.type === 'update' && e.job?.id === job.id && isJobTerminal(e.job.status)) {
              clearTimeout(timer)
              agent.events.off('event', off)
              resolve(e.job)
            }
          }
          agent.events.on('event', off)
        })
        if (done.status !== 'done') throw new Error(`status=${done.status}`)
        const made = (done.artifacts ?? []).find((p) => p.endsWith('greeting.txt'))
        if (!made) throw new Error(`artifact not tracked: ${JSON.stringify(done.artifacts)}`)
        if (!fs.existsSync(made)) throw new Error(`file missing: ${made}`)
        return `${done.engine} → ${made.split('/').slice(-2).join('/')}`
      })
    )
  }

  let failed = 0
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`)
    if (!r.ok) failed++
  }
  console.log(`=== ${results.length - failed}/${results.length} passed ===`)
  return failed
}
