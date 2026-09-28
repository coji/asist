import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useT } from '@/i18n'

export function HoloDialog({
  open,
  onOpenChange,
  title,
  children,
  wide,
  embedded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
  embedded?: boolean
  wide?: boolean
}): React.JSX.Element {
  const t = useT()
  if (embedded)
    return open ? (
      <section className="builtin-focus glass" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button onClick={() => onOpenChange(false)}>
            {t('common.backToConversation')} <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </section>
    ) : (
      <></>
    )
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-(--ui-scrim) backdrop-blur-sm" />
        <DialogPrimitive.Content
          className={`glass fixed top-1/2 left-1/2 z-50 flex max-h-[82vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl p-6 focus:outline-none ${
            wide ? 'max-w-3xl' : 'max-w-xl'
          }`}
        >
          <div className="flex items-center justify-between">
            <DialogPrimitive.Title className="font-mono text-[11px] font-semibold tracking-[0.3em] text-holo-cyan">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="cursor-pointer rounded p-1 text-holo-dim hover:text-holo-text"
              aria-label={t('common.close')}
            >
              <X size={16} />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** The shared layout of one settings row. */
export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex flex-col">
        <span className="text-[13px] text-holo-text">{label}</span>
        {hint && <span className="text-[10.5px] text-holo-dim">{hint}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export const inputClass =
  'rounded-lg border border-holo-line bg-holo-bg/60 px-2.5 py-1.5 text-xs text-holo-text placeholder:text-holo-dim focus:border-holo-cyan/50 focus:outline-none'
