import fs from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'
import { APP_LOG_RETENTION_DAYS, formatLogEntry, redactSecrets, secretValues, type AppLogLevel, type AppLogSource } from '@shared/app-log'
import { expiredDatedFiles, localDateKey } from '@shared/local-date'

/**
 * The app's activity log. It writes main's console output and the warnings and errors of the app's page into
 * one file per day, named YYYY-MM-DD.log. An app started from the Dock or from Finder keeps its standard
 * output nowhere, so the log is written however the app was launched, which is what makes a problem
 * investigable afterwards and attachable to a report.
 *
 * - Appends are synchronous, so that the line just before a crash is not lost. A turn produces a few tens
 *   of lines, which is far too little to slow the conversation down.
 * - Secret values are collected from the environment and from the saved API keys at the moment of each
 *   write and redacted, because a key can be saved from the settings screen later.
 * - A failure to log never stops the app; the failure is reported once on the original console.
 */

/** The cap on one day's file, so that something printing in a loop cannot fill the disk. */
export const APP_LOG_MAX_BYTES = 20 * 1024 * 1024

/** An error message can carry a file path or an address, so only the owner may read the file. */
const FILE_MODE = { mode: 0o600 }

export interface AppLogOptions {
  dir: string
  now?: () => Date
  env?: () => Record<string, string | undefined>
  /** Secrets that never enter the environment, such as the API keys saved in settings. */
  secrets?: () => readonly string[]
  maxBytes?: number
  onError?: (err: unknown) => void
}

export class AppLog {
  private currentFile: string | null = null
  private bytes = 0
  private capped = false
  private failed = false

  constructor(private readonly options: AppLogOptions) {}

  write(level: AppLogLevel, source: AppLogSource, args: readonly unknown[]): void {
    const now = this.options.now?.() ?? new Date()
    const text = args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 6, breakLength: 160 }))).join(' ')
    const entry = formatLogEntry(now, level, source, redactSecrets(text, secretValues(this.options.env?.() ?? process.env, this.options.secrets?.())))
    try {
      const file = path.join(this.options.dir, `${localDateKey(now)}.log`)
      if (file !== this.currentFile) this.open(file, now)
      if (this.capped) return
      const limit = this.options.maxBytes ?? APP_LOG_MAX_BYTES
      if (this.bytes + Buffer.byteLength(entry) > limit) {
        this.capped = true
        fs.appendFileSync(file, formatLogEntry(now, 'warn', 'main', `the log reached its limit of ${limit} bytes for today, so nothing more is written`), FILE_MODE)
        return
      }
      fs.appendFileSync(file, entry, FILE_MODE)
      this.bytes += Buffer.byteLength(entry)
    } catch (err) {
      if (this.failed) return
      this.failed = true
      this.options.onError?.(err)
    }
  }

  private open(file: string, now: Date): void {
    fs.mkdirSync(this.options.dir, { recursive: true })
    this.currentFile = file
    this.capped = false
    this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0
    for (const name of expiredDatedFiles(fs.readdirSync(this.options.dir), now, APP_LOG_RETENTION_DAYS, 'log')) {
      fs.rmSync(path.join(this.options.dir, name), { force: true })
    }
  }
}

const CONSOLE_LEVELS: ReadonlyArray<[keyof Pick<Console, 'debug' | 'log' | 'info' | 'warn' | 'error'>, AppLogLevel]> = [
  ['debug', 'debug'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error']
]

let installed: AppLog | null = null

/** Makes main's console write to the file as well, while its output on standard output stays. */
export function installAppLog(dir: string, secrets: () => readonly string[]): AppLog {
  if (installed) return installed
  const original = { error: console.error.bind(console) }
  const log = new AppLog({ dir, secrets, onError: (err) => original.error('app log: cannot write', err) })
  for (const [method, level] of CONSOLE_LEVELS) {
    const print = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      print(...args)
      log.write(level, 'main', args)
    }
  }
  // An uncaught exception is only recorded here; its handling is left unchanged.
  process.on('uncaughtExceptionMonitor', (err, origin) => log.write('error', 'main', [`${origin}:`, err]))
  installed = log
  return log
}
