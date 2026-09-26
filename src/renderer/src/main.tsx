import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/main.css'
import { rendererApiContractError } from './bridge-contract'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'
import { loadPlatformCapabilities } from '@/platform'

// The demo is allowed on the development server only. A packaged build whose preload is broken must
// not fail open into fake responses and a fake connection state.
const root = ReactDOM.createRoot(document.getElementById('root')!)

function renderFatal(detail: string): void {
  document.documentElement.dataset.preloadFailure = 'true'
  root.render(
    <main className="flex min-h-screen items-center justify-center bg-holo-bg p-8 text-holo-text">
      <section className="max-w-lg rounded-2xl border border-holo-red/30 bg-holo-red/5 p-6">
        <h1 className="text-lg font-semibold">{translate('boot.failed')}</h1>
        <p className="mt-3 text-sm leading-6 text-(--ui-text-soft)">{translate('boot.bridgeFailed')}</p>
        <p className="mt-3 break-all font-mono text-[11px] text-(--ui-tone-red-text)/70">{detail}</p>
      </section>
    </main>
  )
}

async function bootstrap(): Promise<void> {
  // Browser-only UI development can opt into demo data. Vite removes this
  // branch (and its dynamic import) from production builds.
  if (!window.api && import.meta.env.DEV) {
    const { bootDemo } = await import('./demo')
    if (await bootDemo(root)) return
  }

  const bridgeError = rendererApiContractError(window.api)
  if (bridgeError) {
    renderFatal(bridgeError)
    return
  }
  await loadPlatformCapabilities()

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap().catch((error: unknown) => {
  renderFatal(displayError(error))
})
