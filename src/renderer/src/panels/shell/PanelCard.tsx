import { memo } from 'react'
import { motion } from 'motion/react'
import { Maximize2, X } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { usePanelStore } from '@/state/stores'
import { useT } from '@/i18n'
import { cardDefinition } from '@/panels/registry'
import type { CardSize } from './card'
import { PanelContent } from './PanelContent'

/** The card frame in the dock. PanelContent draws what is inside it, and Dock measures the size it is given. */
export const PanelCard = memo(function PanelCard({
  spec,
  size
}: {
  spec: PanelSpec
  size: CardSize
}): React.JSX.Element {
  const dismiss = usePanelStore((s) => s.dismiss)
  const setFocused = usePanelStore((s) => s.setFocused)
  const t = useT()
  const card = cardDefinition(spec.type)

  return (
    <motion.div
      layout
      data-panel-type={spec.type}
      data-size={size}
      initial={{ opacity: 0, y: 22, scale: 0.94, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -10, scale: 0.95, filter: 'blur(6px)' }}
      transition={{ duration: 0.35, ease: [0.2, 0.9, 0.25, 1.15] }}
      className={`glass sheen panel-card group ${card?.className ?? ''}`}
    >
      <PanelContent
        spec={spec}
        size={size}
        actions={
          <>
            <button
              onClick={() => setFocused(spec.key)}
              className="cursor-pointer rounded p-0.5 text-holo-dim opacity-60 transition-opacity hover:text-holo-cyan group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t('panels.expand')}
            >
              <Maximize2 size={12} />
            </button>
            <button
              onClick={() => dismiss(spec.key)}
              className="cursor-pointer rounded p-0.5 text-holo-dim opacity-60 transition-opacity hover:text-holo-text group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t('panels.dismiss')}
            >
              <X size={13} />
            </button>
          </>
        }
      />
    </motion.div>
  )
})
