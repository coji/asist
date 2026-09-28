import type { ConversationLocale, PromptText } from '@shared/conversation-locale'
import type { PanelEvent } from '@shared/ipc'
import { catalogByType } from '@shared/panel-catalog'
import { ToolError, bilingual } from '@shared/tool-registry'
import { fetchPanel } from '../panel-fetchers'
import { cardError, detail, issueText } from './tool-error-text'
import type { ToolContext } from './tools'

/**
 * The cards that list_mail, read_mail, list_tasks and search_notes put up when they are called with
 * `card: true`. The tool returns its own data either way, so the model never has to call a second tool
 * to show what it has just read.
 */

export type DataCard = 'mail' | 'mail-message' | 'todo' | 'notes'

/** The field each of those tools takes, described once. */
export const CARD_FIELD = {
  type: 'boolean',
  description: bilingual({
    ja: 'true で、同じものをカードでも画面に出す。話す内容を見せたいときに付ける',
    en: 'true also puts the same thing on screen as a card. Set it when showing what you talk about helps.'
  })
} as const

const TEXTS = {
  cardFailed: (reason: string): PromptText => ({
    ja: `カードを出せない: ${reason}。card を付けずに呼び直すか、出せなかったことを伝えること。`,
    en: `The card could not be shown: ${reason}. Call again without card, or tell the user it could not be shown.`
  })
} as const

/**
 * Puts up the card. A card that fetches its own data shows as loading until the fetch ends; the notes
 * and tasks cards are drawn from what main already broadcasts to the renderer.
 */
export async function putUpCard(
  type: DataCard,
  props: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
  locale: ConversationLocale
): Promise<void> {
  const entry = catalogByType.get(type)
  if (!entry) throw new Error(`no card of type ${type}`)
  const input = entry.schema.safeParse(props)
  if (!input.success) throw new ToolError(TEXTS.cardFailed(issueText(input.error.issues, locale)))
  const parsed = input.data as Record<string, unknown>
  const key = entry.key(parsed)
  const emit = (event: PanelEvent): void => ctx.emit({ type: 'panel', turnId: ctx.turnId, event })
  if (!entry.fetch) {
    emit({ op: 'create', key, type, slot: entry.slot, props: parsed, state: 'ready', source: 'LOCAL' })
    return
  }
  emit({ op: 'create', key, type, slot: entry.slot, props: parsed, state: 'loading' })
  try {
    const result = await fetchPanel(type, parsed, signal)
    emit({ op: 'patch', key, props: result.props, state: 'ready', source: result.source })
  } catch (err) {
    emit({ op: 'patch', key, state: 'error', error: cardError(err) })
    throw new ToolError(TEXTS.cardFailed(detail(err, locale)))
  }
}
