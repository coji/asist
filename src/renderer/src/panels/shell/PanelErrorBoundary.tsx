import { Component, type ReactNode } from 'react'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'

interface PanelErrorBoundaryProps {
  children: ReactNode
  panelType: string
  revision: number
  /** The header the frame keeps above the error, drawn without anything of the card's own. */
  head: ReactNode
}

export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  { error: string | null }
> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: displayError(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error(`panel crashed (${this.props.panelType}):`, error)
  }

  componentDidUpdate(previous: PanelErrorBoundaryProps): void {
    if (this.state.error && previous.revision !== this.props.revision) this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <>
          {this.props.head}
          <div className="py-1 text-xs leading-relaxed text-holo-red/90" role="alert">
            {translate('panels.renderFailed')}
            <div className="mt-1 font-mono text-[10px] text-holo-dim">
              {this.state.error.slice(0, 90)}
            </div>
          </div>
        </>
      )
    }
    return this.props.children
  }
}
