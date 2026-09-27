import type { MessageKey } from './i18n'
import { errorText } from './i18n/error-text'

/**
 * What this OS and this machine can run, decided once in the main process and handed to the renderer
 * and to the model's tools. A feature that is not available here is left out of the screens and of the
 * tool list rather than shown and failing when used.
 */

export type OsFamily = 'macos' | 'windows'

/** The Python environment the local speech recognition and Qwen3-TTS run in on this machine. */
export type SpeechRuntime = 'mlx'

/** Why this machine cannot run the local speech models, which the screens show in place of the choice. */
export type SpeechRuntimeUnavailable = 'unsupported-os'

/** The sentence the screens show, and an error carries, for each reason. */
export const SPEECH_RUNTIME_UNAVAILABLE_TEXT = {
  'unsupported-os': 'speechRecognition.unavailable.unsupportedOs'
} as const satisfies Record<SpeechRuntimeUnavailable, MessageKey>

export interface PlatformCapabilities {
  /**
   * For wording that names a part of the OS (Finder, File Explorer), and for main's own way of doing a
   * thing each OS does differently, such as where the agent CLIs are installed. No feature is gated on it.
   */
  os: OsFamily
  /** The runtime of the local speech models with the memory it has, or why there is none. */
  speechRuntime: { kind: SpeechRuntime; memoryGb: number } | { kind: null; reason: SpeechRuntimeUnavailable }
  /** The echo-cancelling native microphone helper (macOS voice processing). */
  nativeMic: boolean
  calendar: boolean
  /** The Electron accelerator of the global hotkey; the label on the screen is derived from it. */
  hotkey: string
}

export interface Machine {
  platform: string
  arch: string
  totalMemoryBytes: number
}

/**
 * The capabilities of a machine. Only Apple Silicon Macs and x64 Windows are built for; any other
 * combination fails, because a guess at what it can run would show features that then fail.
 */
export function deriveCapabilities({ platform, arch, totalMemoryBytes }: Machine): PlatformCapabilities {
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      os: 'macos',
      speechRuntime: { kind: 'mlx', memoryGb: Math.max(1, Math.round(totalMemoryBytes / 1024 ** 3)) },
      nativeMic: true,
      calendar: true,
      hotkey: 'Alt+Space'
    }
  }
  if (platform === 'win32' && arch === 'x64') {
    return {
      os: 'windows',
      speechRuntime: { kind: null, reason: 'unsupported-os' },
      nativeMic: false,
      calendar: false,
      // On a Windows 11 machine with PowerToys, Copilot and Claude running (2026-09-27), Alt+Space and
      // Ctrl+Alt+Space were already taken, as were Ctrl+Win+Space and Win+Shift+Space, which switch the
      // input language. Ctrl+Shift+Space was free but is a key inside Word and VS Code.
      hotkey: 'Alt+Shift+Space'
    }
  }
  throw new Error(errorText('app.startup.unsupportedPlatform', { platform, arch }))
}

/** The symbols macOS menus write the modifier keys with. */
const MAC_MODIFIERS: Record<string, string> = { Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Cmd: '⌘', Command: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘' }

/** The hotkey as this OS writes a shortcut: ⌥Space on macOS, Alt+Shift+Space on Windows. */
export function hotkeyLabel({ os, hotkey }: Pick<PlatformCapabilities, 'os' | 'hotkey'>): string {
  if (os === 'windows') return hotkey
  return hotkey
    .split('+')
    .map((part) => MAC_MODIFIERS[part] ?? part)
    .join('')
}
