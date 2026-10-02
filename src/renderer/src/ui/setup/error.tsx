import { useEffect, useRef } from 'react'

/**
 * The error of the last action, at the end of the step. A step can be taller than the dialog, so the
 * error is scrolled into view when it appears, with the content just above it, such as the buttons of
 * the engine that failed, still in view. Pinned to the bottom edge instead, it would cover that content.
 */
export function SetupError({ message }: { message: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [message])
  return (
    <div ref={ref} className="su-error" role="alert">
      {message}
    </div>
  )
}
