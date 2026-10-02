import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { usePanelStore } from '@/state/stores'
import { keyForApp } from '@/ui/key-for-app'
import { useT } from '@/i18n'
import { cardDefinition } from '@/panels/registry'
import { hasCardData } from '@/panels/shell/card'
import { PanelContent } from '@/panels/shell/PanelContent'

/** The frame of an enlarged card. FocusOverlay shows it in the center, and the demo's card gallery lines up the same frame. */
export function FocusCard({ spec, onClose }: { spec: PanelSpec; onClose: () => void }): React.JSX.Element {
  const card = cardDefinition(spec.type)
  const context = { spec, size: 'focus' as const }
  const t = useT()
  return (
    <motion.div
      initial={{ scale: 0.92, y: 14 }}
      animate={{ scale: 1, y: 0 }}
      exit={{ scale: 0.95, y: 8 }}
      transition={{ duration: 0.25, ease: [0.2, 0.9, 0.25, 1.1] }}
      data-panel-type={spec.type}
      data-size="focus"
      className={`glass sheen panel-focus ${card?.className ?? ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {hasCardData(spec) && card?.backdrop && (
        <div className="panel-backdrop" aria-hidden>
          {card.backdrop(context)}
        </div>
      )}
      <header className={hasCardData(spec) && card?.backdrop ? 'panel-head ui-on-scene' : 'panel-head'}>
        <span className="panel-kicker">{card?.kicker ?? spec.type.toUpperCase()} · FOCUS</span>
        <span className="panel-head-side">
          {hasCardData(spec) && card?.meta && <span className="panel-meta">{card.meta(context)}</span>}
          <button
            onClick={onClose}
            className="cursor-pointer rounded p-1 text-holo-dim hover:text-holo-text"
            aria-label={t('panels.closeFocus')}
          >
            <X size={16} />
          </button>
        </span>
      </header>
      <div className="[&_[class*=line-clamp-]]:!line-clamp-none">
        <PanelContent spec={spec} size="focus" />
      </div>
    </motion.div>
  )
}

/** Focus mode, which enlarges a single panel in the center, for instance to show the whole weekly forecast. */
export function FocusOverlay(): React.JSX.Element {
  const focusedKey = usePanelStore((s) => s.focusedKey)
  const setFocused = usePanelStore((s) => s.setFocused)
  const spec = usePanelStore((s) => s.panels.find((p) => p.key === s.focusedKey))

  useEffect(() => {
    if (!focusedKey) return
    const onKey = (e: KeyboardEvent): void => {
      if (keyForApp(e) === 'Escape') setFocused(null)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [focusedKey, setFocused])

  return (
    <AnimatePresence>
      {spec && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-(--ui-scrim) backdrop-blur-sm"
          onClick={() => setFocused(null)}
        >
          <FocusCard spec={spec} onClose={() => setFocused(null)} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
