import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { app } from 'electron'
import { childEnv } from './child-env'

/**
 * The processes the local speech runs in, and the JSON-lines protocol of the worker ones: every stdout
 * line that carries a message starts with `ASIST_JSON:`, the first message is `ready` (or `fatal`), and
 * stderr goes to the app log under the worker's name. Quitting the app stops every one of them.
 */

const PROTOCOL_PREFIX = 'ASIST_JSON:'

/**
 * Loading a model and compiling its GPU kernels comes before `ready`. The first start of the Qwen3-TTS worker
 * after a GPU driver update compiled its Vulkan shaders for 12.6 s on an RTX 2080 (2026-09-29).
 */
const WORKER_READY_TIMEOUT_MS = 180_000

const children = new Set<ChildProcess>()
let quitHookRegistered = false

/** Stops `child` when the app quits, unless it has ended by then. */
export function stopOnQuit(child: ChildProcess): void {
  children.add(child)
  child.once('exit', () => children.delete(child))
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => {
    for (const running of [...children]) running.kill('SIGTERM')
  })
}

export interface WorkerOptions {
  /** Every protocol message except `ready` and `fatal`. */
  onMessage: (message: Record<string, unknown>) => void
  /** The worker failed to load, crashed or exited on its own. It is not called after `stop()`. */
  onFailure: (error: Error) => void
}

/** One running worker. `ready` settles once: true on the worker's `ready` message, false when it fails or is stopped first. */
export class SpeechWorker {
  readonly ready: Promise<boolean>
  /** The fields of the `ready` message, available once `ready` resolved true. */
  info: Record<string, unknown> = {}
  private stopped = false
  private settleReady!: (ready: boolean) => void

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly logName: string,
    private readonly options: WorkerOptions
  ) {
    this.ready = new Promise<boolean>((resolve) => { this.settleReady = resolve })
    const timeout = setTimeout(() => this.fail(new Error(`${logName} worker did not become ready`)), WORKER_READY_TIMEOUT_MS)
    void this.ready.then(() => clearTimeout(timeout))
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.error(`${logName}: ${line}`)
    })
    child.on('error', (error) => this.fail(error))
    child.on('exit', (code) => this.fail(new Error(`${logName} worker exited (${code ?? 'signal'})`)))
    // A write between the worker's death and its exit event fails with EPIPE, which becomes an uncaught
    // exception unless the stream has a listener.
    child.stdin.on('error', (error) => this.fail(error))
  }

  get alive(): boolean {
    return !this.stopped && this.child.exitCode === null && !this.child.killed
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.settleReady(false)
    if (this.child.exitCode === null && !this.child.killed) this.child.kill('SIGTERM')
  }

  private fail(error: Error): void {
    if (this.stopped) return
    this.stop()
    this.options.onFailure(error)
  }

  private handleLine(line: string): void {
    if (this.stopped) return
    const marker = line.indexOf(PROTOCOL_PREFIX)
    if (marker < 0) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line.slice(marker + PROTOCOL_PREFIX.length))
    } catch {
      return
    }
    if (message.type === 'ready') {
      this.info = message
      this.settleReady(true)
    } else if (message.type === 'fatal') {
      this.fail(new Error(typeof message.error === 'string' && message.error ? message.error : `${this.logName} worker failed to load`))
    } else {
      this.options.onMessage(message)
    }
  }
}

/** Starts `command` as a JSON-lines worker. */
export function startSpeechWorker(command: string, args: string[], logName: string, options: WorkerOptions): SpeechWorker {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), windowsHide: true })
  stopOnQuit(child)
  return new SpeechWorker(child, logName, options)
}
