import type { PlatformCapabilities } from '@shared/platform'

let loaded: PlatformCapabilities | null = null

/**
 * Reads what this machine can run from the main process. The value never changes while the app runs,
 * so it is read once before anything is drawn, and every screen reads it synchronously afterwards.
 */
export async function loadPlatformCapabilities(): Promise<void> {
  loaded ??= await window.api.getPlatformCapabilities()
}

/** What this machine can run. The screens decide what to offer from this alone, never from the OS. */
export function platformCapabilities(): PlatformCapabilities {
  if (!loaded) throw new Error('the platform capabilities are read before they are loaded')
  return loaded
}
