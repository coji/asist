import fs from 'node:fs'
import { addUsage, localDate, usageDaysSchema, type UsageDay, type UsageItem } from '@shared/api-usage'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { storedContent, type StoredFormat } from '@shared/stored-format'
import { dataPath, writeJson } from './store'
import { openStoredFileSync } from './stored-file'

/**
 * The record of paid API use behind the costs page of the settings. The days are summed as they come
 * in, because a conversation calls the bridge model several times per utterance and a line per call
 * would grow the file by megabytes a week.
 */

const USAGE_FILE = 'api-usage.json'

/**
 * Version 1 was the bare list of days; version 2 is an object, which is what can carry the version. Version 3
 * says who paid for each model call, and every call until then was paid through an API key.
 */
export const USAGE_FORMAT: StoredFormat<UsageDay[]> = {
  name: USAGE_FILE,
  version: 3,
  upgrades: {
    1: (content) => ({ days: content }),
    2: (content) => {
      const stored = content as { days?: unknown }
      if (!Array.isArray(stored.days)) return stored
      const days = stored.days.map((day: unknown) => {
        const items = (day as { items?: unknown } | null)?.items
        if (!Array.isArray(items)) return day
        return { ...(day as object), items: items.map((item: unknown) => ((item as { kind?: unknown } | null)?.kind === 'llm' ? { ...(item as object), billing: 'api' } : item)) }
      })
      return { ...stored, days }
    }
  },
  parse: (content) => usageDaysSchema.parse((content as { days?: unknown } | null)?.days),
  serialize: (usage) => ({ days: usage })
}

let days: UsageDay[] | null = null

/** Only a missing file counts as no use yet, so that an invalid file is never overwritten by a fresh one. */
function load(): UsageDay[] {
  if (days) return days
  const file = dataPath(USAGE_FILE)
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (days = [])
    throw new Error(errorText('settingsUsage.errors.unreadable', { file, detail: errMessage(error) }))
  }
  try {
    return (days = openStoredFileSync(file, JSON.parse(source) as unknown, USAGE_FORMAT))
  } catch (error) {
    throw new Error(errorText('settingsUsage.errors.invalid', { file, detail: errMessage(error) }))
  }
}

export function usageDays(): UsageDay[] {
  return load()
}

/**
 * Adds a use to today. A failure is logged rather than thrown, because it comes at the end of a
 * conversation turn or a job that has already been paid for and has to finish.
 */
export function recordUsage(item: UsageItem, at = new Date()): void {
  try {
    const next = addUsage(load(), localDate(at), item)
    writeJson(USAGE_FILE, storedContent(USAGE_FORMAT, next))
    days = next
  } catch (error) {
    console.error('usage-ledger: could not record the use of', item.kind, errMessage(error))
  }
}
