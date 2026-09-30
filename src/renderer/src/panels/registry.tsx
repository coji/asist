import { weatherCard } from './builtin/weather'
import { fxCard } from './builtin/fx'
import { clockCard } from './builtin/clock'
import { timerCard } from './builtin/timer'
import { newsCard } from './builtin/news'
import { searchResultsCard } from './builtin/search-results'
import { calendarCard } from './builtin/calendar'
import { todoCard } from './builtin/todo'
import { mailCard } from './builtin/mail'
import { mailDraftCard } from './builtin/mail-draft'
import { mailMessageCard } from './builtin/mail-message'
import { notesCard } from './builtin/notes'
import { agentJobCard } from './builtin/agent-job'
import { jobsCard } from './builtin/jobs'
import { mapCard } from './builtin/map'
import { filesCard } from './builtin/files'
import type { CardDefinition } from './shell/card'

const CARDS: Record<string, CardDefinition> = {
  weather: weatherCard,
  fx: fxCard,
  clock: clockCard,
  timer: timerCard,
  news: newsCard,
  'search-results': searchResultsCard,
  calendar: calendarCard,
  todo: todoCard,
  mail: mailCard,
  'mail-draft': mailDraftCard,
  'mail-message': mailMessageCard,
  notes: notesCard,
  'agent-job': agentJobCard,
  jobs: jobsCard,
  map: mapCard,
  files: filesCard
}

/** The card that draws a type, or undefined for a type no card draws. */
export const cardDefinition = (type: string): CardDefinition | undefined => CARDS[type]
