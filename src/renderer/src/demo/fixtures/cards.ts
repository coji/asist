import type { PanelState } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { DEMO_CALENDAR_CARD } from './calendar'
import { DEMO_FX, demoFx } from './finance'
import { DEMO_JOB } from './jobs'
import { DEMO_DOWNLOADS_DIR, DEMO_FILES_DIR, DEMO_IMAGE_PATHS, DEMO_MIXED_PATHS, demoFileItems } from './files'
import { DEMO_PDF_PATHS } from './files-pdf'
import { DEMO_CODE_PATH, DEMO_HTML_PATH, DEMO_JSON_PATH, DEMO_NOTEBOOK_PATH } from './files-code'
import { DEMO_AUDIO_PATH, DEMO_VIDEO_PATH } from './files-media'
import { DEMO_DOCX_PATH, DEMO_LARGE_XLSX_PATH, DEMO_PPTX_PATH, DEMO_XLSX_PATH } from './files-office'
import { DEMO_MAIL_CARD, DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGE_CARD } from './mail'
import { DEMO_NEWS, DEMO_SEARCH, DEMO_SEARCH_GOOGLE } from './reading'
import { DEMO_TIMER, demoClock } from './time'
import { DEMO_WEATHER_MUNICH, DEMO_WEATHER_NAGANO, onDemoDay } from './weather'
import { translate } from '@/i18n'

/**
 * One sample of every card type. The card list (/cards) and the gallery that "/g1" through "/g4" open in
 * the conversation use the same data. A new card type gets one sample added here.
 */
export interface CardFixture {
  type: string
  /** Tells apart several samples of one type, such as the pdf or video variants of files. It appears in the list and in the URL. */
  variant?: string
  props: Record<string, unknown>
  /** A getter where the main process writes the source in the interface language, which is not known when this module loads. */
  source?: string
  /** Defaults to ready when omitted, and is set on the loading, error and stale samples. */
  state?: PanelState
  /** The message shown when state is error. */
  error?: string
}

/** The name of a single sample, as it appears in the URL (/cards/files-pdf). */
export const fixtureId = (fixture: CardFixture): string => (fixture.variant ? `${fixture.type}-${fixture.variant}` : fixture.type)

export const CARD_GROUPS: Array<{ command: string; label: string; cards: CardFixture[] }> = [
  {
    command: '/g1',
    label: '天気・金融・時間',
    cards: [
      { type: 'weather', props: { location: '長野県', date: 'today', weather: onDemoDay(DEMO_WEATHER_NAGANO) } },
      { type: 'weather', variant: 'world', props: { location: 'Munich', date: 'today', weather: onDemoDay(DEMO_WEATHER_MUNICH) } },
      { type: 'fx', props: DEMO_FX, source: 'open.er-api.com' },
      { type: 'fx', variant: 'small-rate', props: demoFx('VND', 'USD', null), source: 'open.er-api.com' },
      { type: 'clock', props: demoClock('ニューヨーク'), source: 'America/New_York' },
      { type: 'timer', props: DEMO_TIMER }
    ]
  },
  {
    command: '/g2',
    label: '読み物・地図',
    cards: [
      { type: 'news', props: DEMO_NEWS, source: 'Google News' },
      { type: 'search-results', props: DEMO_SEARCH, source: 'web_search' },
      { type: 'search-results', variant: 'google', props: DEMO_SEARCH_GOOGLE, source: 'web_search' },
      { type: 'map', props: { place: '東京駅', mode: 'place' } }
    ]
  },
  {
    command: '/g3',
    label: '記録・Agent',
    cards: [
      { type: 'calendar', props: DEMO_CALENDAR_CARD, get source() { return translate('calendar.card.source') } },
      { type: 'todo', props: {} },
      { type: 'mail', props: DEMO_MAIL_CARD, source: 'IMAP · 仕事 / 個人' },
      { type: 'mail-message', props: DEMO_MAIL_MESSAGE_CARD, source: 'IMAP · 仕事' },
      { type: 'mail-draft', props: { draftId: DEMO_MAIL_DRAFTS[0].id } },
      { type: 'mail-draft', variant: 'reply', props: { draftId: DEMO_MAIL_DRAFTS[1].id } },
      { type: 'mail-draft', variant: 'started', props: { draftId: DEMO_MAIL_DRAFTS[2].id } },
      { type: 'notes', props: {} },
      { type: 'agent-job', props: { jobId: DEMO_JOB.id } },
      { type: 'jobs', props: {} }
    ]
  },
  {
    command: '/g4',
    label: 'ファイル',
    cards: [
      { type: 'files', variant: 'markdown', props: { paths: [`${DEMO_FILES_DIR}/report.md`], title: '調査レポート', items: demoFileItems([`${DEMO_FILES_DIR}/report.md`]) }, source: 'markdown' },
      { type: 'files', variant: 'images', props: { paths: DEMO_IMAGE_PATHS, title: '調査のグラフ', items: demoFileItems(DEMO_IMAGE_PATHS) }, get source() { return translate('files.source', { count: 3 }) } },
      { type: 'files', variant: 'mixed', props: { paths: DEMO_MIXED_PATHS, title: '競合サービスの調査', items: demoFileItems(DEMO_MIXED_PATHS) }, get source() { return translate('files.source', { count: 6 }) } },
      { type: 'files', variant: 'directory', props: { paths: [DEMO_FILES_DIR], items: demoFileItems([DEMO_FILES_DIR]) }, source: 'directory' },
      { type: 'files', variant: 'large-directory', props: { paths: [DEMO_DOWNLOADS_DIR], items: demoFileItems([DEMO_DOWNLOADS_DIR]) }, source: 'directory' },
      { type: 'files', variant: 'table', props: { paths: [`${DEMO_FILES_DIR}/pricing.csv`], items: demoFileItems([`${DEMO_FILES_DIR}/pricing.csv`]) }, source: 'table' },
      { type: 'files', variant: 'pdf', props: { paths: DEMO_PDF_PATHS, items: demoFileItems(DEMO_PDF_PATHS) }, source: 'pdf' },
      { type: 'files', variant: 'code', props: { paths: [DEMO_CODE_PATH], items: demoFileItems([DEMO_CODE_PATH]) }, source: 'code' },
      { type: 'files', variant: 'html', props: { paths: [DEMO_HTML_PATH], title: '競合サービスの比較', items: demoFileItems([DEMO_HTML_PATH]) }, source: 'code' },
      { type: 'files', variant: 'json', props: { paths: [DEMO_JSON_PATH], items: demoFileItems([DEMO_JSON_PATH]) }, source: 'data' },
      { type: 'files', variant: 'notebook', props: { paths: [DEMO_NOTEBOOK_PATH], items: demoFileItems([DEMO_NOTEBOOK_PATH]) }, source: 'notebook' },
      { type: 'files', variant: 'video', props: { paths: [DEMO_VIDEO_PATH], title: 'ヒアリングの録画', items: demoFileItems([DEMO_VIDEO_PATH]) }, source: 'video' },
      { type: 'files', variant: 'audio', props: { paths: [DEMO_AUDIO_PATH], title: 'ヒアリングの録音', items: demoFileItems([DEMO_AUDIO_PATH]) }, source: 'audio' },
      { type: 'files', variant: 'docx', props: { paths: [DEMO_DOCX_PATH], items: demoFileItems([DEMO_DOCX_PATH]) }, source: 'docx' },
      { type: 'files', variant: 'xlsx', props: { paths: [DEMO_XLSX_PATH], items: demoFileItems([DEMO_XLSX_PATH]) }, source: 'xlsx' },
      { type: 'files', variant: 'pptx', props: { paths: [DEMO_PPTX_PATH], items: demoFileItems([DEMO_PPTX_PATH]) }, source: 'pptx' },
      { type: 'files', variant: 'too-large', props: { paths: [DEMO_LARGE_XLSX_PATH], items: demoFileItems([DEMO_LARGE_XLSX_PATH]) }, source: 'xlsx' }
    ]
  }
]

/**
 * The samples for incomplete data. They show what the shell draws while loading, on failure and when the
 * data is stale, and what a card that throws looks like. Only the card list uses them; "/g1" and the
 * other gallery commands do not.
 */
export const STATE_GROUP: { command: string; label: string; cards: CardFixture[] } = {
  command: '',
  label: '揃っていない状態',
  cards: [
    { type: 'fx', variant: 'loading', state: 'loading', props: { base: 'USD', quote: 'JPY' } },
    {
      type: 'fx',
      variant: 'error',
      state: 'error',
      error: errorText('panels.errors.fetchFailed', { host: 'open.er-api.com', status: 429 }),
      props: { base: 'USD', quote: 'JPY' }
    },
    { type: 'fx', variant: 'stale', state: 'stale', props: DEMO_FX, source: 'open.er-api.com' },
    // A map without a location throws while its input is validated, and the per-card error boundary catches it.
    { type: 'map', variant: 'crash', props: {} }
  ]
}
