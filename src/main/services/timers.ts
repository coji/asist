import { app, powerMonitor } from 'electron'
import fs from 'node:fs'
import mitt from 'mitt'
import { errorText } from '@shared/i18n/error-text'
import type { AppTimer, TimerCreateRequest, TimerEvent } from '@shared/ipc'
import { TIMERS_FORMAT, TimerManager, type TimerPersistenceData } from '@shared/timer-manager'
import { storedContent } from '@shared/stored-format'
import { notifyFromRenderer } from '../os-integration'
import { t } from './i18n'
import { dataPath } from './store'
import { writeJsonFileAtomicSync } from './atomic-json'
import { openStoredFileSync } from './stored-file'

const FILE = 'timers.json'
const EMPTY: TimerPersistenceData = { timers: [] }

export const events = mitt<{ event: TimerEvent }>()

const manager = new TimerManager({
  load: readTimerPersistence,
  save: writeTimerPersistence,
  defaultLabel: () => t('cardsTime.timer.defaultLabel'),
  notify: (timer) => notifyFromRenderer(t('cardsTime.timer.finished'), timer.label),
  onEvent: (event) => events.emit('event', event)
})

let hooksRegistered = false

export function init(): void {
  try {
    manager.init()
  } catch (error) {
    // The app still starts, but a corrupt file or one from a future schema is never treated as empty and
    // overwritten. list, create and cancel retry the same strict load and fail loudly instead.
    console.error('timer persistence is unavailable:', error)
  }
  if (!hooksRegistered) {
    hooksRegistered = true
    powerMonitor.on('resume', () => manager.resync())
    app.once('will-quit', () => manager.shutdown())
  }
}

export function list(): AppTimer[] {
  return manager.list()
}

export function create(request: TimerCreateRequest): AppTimer {
  return manager.create(request)
}

export function cancel(id: string): boolean {
  return manager.cancel(id)
}

export function shutdown(): void {
  manager.shutdown()
}

/** Only ENOENT counts as a first launch. Corruption, a permission error and a future schema are all raised to the caller. */
function readTimerPersistence(): unknown {
  const file = dataPath(FILE)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return structuredClone(EMPTY)
    throw new Error(errorText('cardsTime.timer.errors.readFailed'), { cause: error })
  }
  let stored: unknown
  try {
    stored = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(errorText('cardsTime.timer.errors.brokenJson'), { cause: error })
  }
  return openStoredFileSync(file, stored, TIMERS_FORMAT)
}

/** The atomic writer for the timers, which is unreachable while the strict load is failing. */
function writeTimerPersistence(value: TimerPersistenceData): void {
  writeJsonFileAtomicSync(dataPath(FILE), storedContent(TIMERS_FORMAT, value))
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
