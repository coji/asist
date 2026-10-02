import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ViewerProps } from './types'
import { ScrollRoot } from './use-near'

/**
 * The frame that holds a viewer's content. Inside a card the height is cut, the frame scrolls, and the bottom
 * edge is blurred where it was cut. The limit per size reaches CSS as --fv-max, and the values fit the shell's
 * box. In the focus view the frame shows everything, and the focus card around it scrolls.
 */
export const FRAME_MAX_HEIGHT: Record<ViewerProps['size'], number> = { l: 420, m: 330, s: 220, focus: 0 }

export function Frame({
  mode,
  size,
  children,
  className
}: {
  mode: ViewerProps['mode']
  size: ViewerProps['size']
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || mode !== 'card') return
    const check = (): void => setClipped(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [mode, children])
  const scroll = (
    <div ref={ref} className="fv-scroll">
      {children}
    </div>
  )
  return (
    <div
      className={className ? `fv-frame ${className}` : 'fv-frame'}
      data-mode={mode}
      data-clipped={clipped ? 'true' : undefined}
      style={mode === 'card' ? ({ '--fv-max': `${FRAME_MAX_HEIGHT[size]}px` } as React.CSSProperties) : undefined}
    >
      {mode === 'card' ? <ScrollRoot.Provider value={ref}>{scroll}</ScrollRoot.Provider> : scroll}
    </div>
  )
}
