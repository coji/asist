import { create } from 'zustand'
import type { PreparationTarget, SetupProgress } from '@shared/ipc'
import { displayError } from '@/display-error'
import { useViewStore } from '@/state/view'

/**
 * The preparations started from the settings. A download runs for minutes and goes on after the settings
 * close, so it is kept here rather than in the settings screen: opened again, the screen shows the
 * preparation still running with its progress, or how it ended, and starts no second one beside it.
 */
export interface Preparation {
  /** The item main is preparing for the settings and how far it has come, or null while none is. Only one runs at a time. */
  running: { target: PreparationTarget; progress: SetupProgress | null } | null
  /** How far Whisper in the browser has come, in percent, or null while it is not being prepared. It downloads inside the window, beside whatever main prepares. */
  localAsr: number | null
  /** How the last preparation ended, shown at the top of the settings until they close. */
  message: string
  /** How many preparations in main have ended. Each one changes what is installed, which the settings then read again. */
  ended: number
}

interface PreparationState extends Preparation {
  /** Runs a preparation in main, then `after` with whether it succeeded. Nothing happens while another one runs. */
  run: (
    target: PreparationTarget,
    operation: () => Promise<{ ok: boolean; message: string }>,
    after?: (ok: boolean) => Promise<unknown> | void
  ) => Promise<void>
  /** Prepares Whisper in the browser, unless that is under way. `operation` reports the percent and resolves to the message to show. */
  runLocalAsr: (operation: (onProgress: (percent: number) => void) => Promise<string>) => Promise<void>
}

const STARTED: SetupProgress = { status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0 }

export const usePreparationStore = create<PreparationState>((set, get) => ({
  running: null,
  localAsr: null,
  message: '',
  ended: 0,
  run: async (target, operation, after) => {
    if (get().running) return
    set({ running: { target, progress: STARTED }, message: '' })
    const stop = window.api.onSetupProgress((progress) => {
      if (progress.target !== target) return
      set((current) =>
        progress.status === 'downloading'
          ? { running: { target, progress } }
          : { running: { target, progress: null }, message: progress.message ?? current.message }
      )
    })
    try {
      const result = await operation()
      set({ message: result.message })
      await after?.(result.ok)
    } catch (error) {
      set({ message: displayError(error) })
    } finally {
      stop()
      set((current) => ({ running: null, ended: current.ended + 1 }))
    }
  },
  runLocalAsr: async (operation) => {
    if (get().localAsr !== null) return
    set({ localAsr: 0, message: '' })
    try {
      set({ message: await operation((percent) => set({ localAsr: percent })) })
    } catch (error) {
      set({ message: displayError(error) })
    } finally {
      set({ localAsr: null })
    }
  }
}))

// The message goes once the settings close, and one that arrives while they are closed waits for the next
// time they open. The view store tells when they close; an effect's cleanup in the settings screen cannot,
// since StrictMode runs it right after mounting.
useViewStore.subscribe((view, previous) => {
  if (previous.open?.app === 'settings' && view.open?.app !== 'settings') usePreparationStore.setState({ message: '' })
})
