import { askConfirm } from '@/state/confirm'
import { useLeaveGuard } from '@/state/view'
import { useT } from '@/i18n'

/**
 * Keeps what is typed in a pane of the mail view from being thrown away unasked. While `holding` is true,
 * the returned function asks first, and it is the leave guard of the mail view, so that openApp, closeApp
 * and the view's own moves ask the same. Once the user agrees, or at once while nothing is held, it runs
 * `discard` and answers true. `discard` leaves the pane holding nothing, as a leave guard has to before the
 * view changes.
 */
export function useAskBeforeDiscard(holding: boolean, discard: () => void): () => Promise<boolean> {
  const t = useT()
  const ask = async (): Promise<boolean> => {
    if (holding && !(await askConfirm({ message: t('common.confirmDiscard'), confirmLabel: t('common.discardChanges'), destructive: true }))) return false
    discard()
    return true
  }
  useLeaveGuard(holding, ask)
  return ask
}
