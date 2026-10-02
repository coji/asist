import type { MessageKey, Translate } from '@shared/i18n'
import type { BridgeOutcome } from '@shared/ipc'
import { displayError } from '@/display-error'
import type { RouterNote } from '@/state/stores'

/** Why a bridge never sounded, as the HUD says it. It names no phrase, which would read as one ASIST said. */
const BRIDGE_NOT_PLAYED = {
  late: 'hud.router.bridgeLate',
  unsettled: 'hud.router.bridgeUnsettled',
  declined: 'hud.router.bridgeDeclined',
  failed: 'hud.router.bridgeFailed'
} as const satisfies Record<Exclude<BridgeOutcome, 'played'>, MessageKey>

/** What the HUD calls the tool the turn is running. A tool with no name of its own is shown by its own name. */
function toolLabel(t: Translate, name: string, detail?: string): string {
  switch (name) {
    case 'web_search':
      return detail ? t('hud.tool.webSearchQuery', { query: detail }) : t('hud.tool.webSearch')
    case 'run_agent_task':
      return t('hud.tool.runAgent')
    case 'get_agent_job':
      return t('hud.tool.checkJobs')
    case 'cancel_agent_job':
      return t('hud.tool.cancelJob')
    case 'recall':
      return t('hud.tool.recall')
    default:
      return name.startsWith('show_') ? t('hud.tool.card', { name: name.slice('show_'.length) }) : name
  }
}

/**
 * The sentence the HUD shows for the routing of the latest turn, in the language of the translator, beside
 * the measurements of `shownUtterance`. The bridge of another utterance says nothing there, since it is
 * not the bridge of the turn those measurements are of.
 */
export function routerNoteText(note: RouterNote, t: Translate, shownUtterance: number | null): string {
  switch (note.kind) {
    case 'bridge':
      if (note.utterance !== shownUtterance) return ''
      return note.outcome === 'played' ? t('hud.router.bridge', { text: note.text }) : t(BRIDGE_NOT_PLAYED[note.outcome])
    case 'aizuchi':
      return t('hud.router.aizuchi', { kind: t(`hud.aizuchiClass.${note.cls}`), percent: note.percent })
    case 'live': {
      const state = t(`hud.connection.${note.state}`)
      return note.detail ? t('hud.router.liveDetail', { state, detail: displayError(note.detail) }) : t('hud.router.live', { state })
    }
    case 'tool':
      return t('hud.router.tool', { tool: toolLabel(t, note.name, note.detail), status: t(`hud.toolStatus.${note.status}`) })
    default:
      return t(`hud.router.${note.kind}`)
  }
}
