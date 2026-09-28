import type { MessageKey } from './i18n'
import { errorText } from './i18n/error-text'
import type { NvidiaGpuSupport, NvidiaGpuUnavailable } from './nvidia-gpu'

/**
 * What this OS and this machine can run, decided once in the main process and handed to the renderer
 * and to the model's tools. A feature that is not available here is left out of the screens and of the
 * tool list rather than shown and failing when used.
 */

export type OsFamily = 'macos' | 'windows'

/**
 * The Python environment the local speech models run in on this machine: MLX on an Apple Silicon Mac,
 * and torch built for CUDA on Windows with an NVIDIA GPU, which runs only the speech recognition.
 */
export type SpeechRuntime = 'mlx' | 'cuda'

/**
 * Why this machine cannot run the local speech models, which the screens show in place of the choice.
 * Only Windows can lack them, for want of a GPU the CUDA runtime runs on or of a check that found one.
 */
export type SpeechRuntimeUnavailable = NvidiaGpuUnavailable

/**
 * Where the calendar reads and writes events: the Mac's own calendars through EventKit, or one Google
 * account through the Google Calendar API.
 */
export type CalendarBackend = 'eventkit' | 'google'

/** The environment variable that makes both systems use Google Calendar, for development until Google verifies the app. */
export const CALENDAR_BACKEND_VARIABLE = 'ASIST_CALENDAR_BACKEND'

/** The sentence the screens show, and an error carries, for each reason. */
export const SPEECH_RUNTIME_UNAVAILABLE_TEXT = {
  'no-nvidia-gpu': 'speechRecognition.unavailable.noNvidiaGpu',
  'gpu-too-old': 'speechRecognition.unavailable.gpuTooOld',
  'driver-too-old': 'speechRecognition.unavailable.driverTooOld',
  'gpu-check-failed': 'speechRecognition.unavailable.gpuCheckFailed'
} as const satisfies Record<SpeechRuntimeUnavailable, MessageKey>

export interface PlatformCapabilities {
  /**
   * For wording that names a part of the OS (Finder, File Explorer), and for main's own way of doing a
   * thing each OS does differently, such as where the agent CLIs are installed. No feature is gated on it.
   */
  os: OsFamily
  /**
   * The runtime of the local speech models with the memory the models are loaded into, or why there is
   * none. The memory is the Mac's own on mlx, which the models share with every other app, and the GPU's
   * on cuda; each runtime's model table decides its recommendation from that number alone.
   */
  speechRuntime: { kind: SpeechRuntime; memoryGb: number } | { kind: null; reason: SpeechRuntimeUnavailable }
  /**
   * The native microphone helper, which captures with the echo of everything the machine plays cancelled:
   * voice processing on macOS, the communications echo canceller on Windows. Without it the renderer
   * captures through getUserMedia.
   */
  nativeMic: boolean
  /** Where the calendar lives, or null where there is none. */
  calendar: CalendarBackend | null
  /** The Electron accelerator of the global hotkey; the label on the screen is derived from it. */
  hotkey: string
}

export interface Machine {
  platform: string
  arch: string
  totalMemoryBytes: number
  /** Asked only on Windows, where it runs nvidia-smi. */
  nvidiaGpu: () => NvidiaGpuSupport
  /**
   * Whether the Windows microphone helper finds echo cancellation on for the default microphone, which main
   * answers by running the helper's check. It is asked on Windows alone: every macOS the app supports has
   * voice processing.
   */
  micCancelsEcho: () => boolean
  /** The value of ASIST_CALENDAR_BACKEND, undefined when it is not set. */
  calendarBackend: string | undefined
  /** Whether the build carries the OAuth client ASIST signs in to Google with, asked only when Google is. */
  googleClient: () => boolean
}

/**
 * The calendar of a machine: the OS's own default, or Google on both systems when the variable asks for
 * it. Google without its OAuth client, or a value the variable does not know, stops the launch rather than
 * leave the calendar on something the developer did not ask for.
 */
function calendarOf(osDefault: CalendarBackend | null, requested: string | undefined, googleClient: () => boolean): CalendarBackend | null {
  if (requested === undefined || requested === '') return osDefault
  if (requested !== 'google') throw new Error(errorText('app.startup.calendarBackendUnknown', { variable: CALENDAR_BACKEND_VARIABLE, value: requested }))
  if (!googleClient()) throw new Error(errorText('app.startup.googleClientMissing', { variable: CALENDAR_BACKEND_VARIABLE }))
  return 'google'
}

/**
 * The capabilities of a machine. Only Apple Silicon Macs and x64 Windows are built for; any other
 * combination fails, because a guess at what it can run would show features that then fail.
 */
export function deriveCapabilities(machine: Machine): PlatformCapabilities {
  const { platform, arch, totalMemoryBytes, nvidiaGpu, micCancelsEcho } = machine
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      os: 'macos',
      speechRuntime: { kind: 'mlx', memoryGb: Math.max(1, Math.round(totalMemoryBytes / 1024 ** 3)) },
      nativeMic: true,
      calendar: calendarOf('eventkit', machine.calendarBackend, machine.googleClient),
      hotkey: 'Alt+Space'
    }
  }
  if (platform === 'win32' && arch === 'x64') {
    const gpu = nvidiaGpu()
    return {
      os: 'windows',
      speechRuntime: gpu.usable ? { kind: 'cuda', memoryGb: gpu.memoryGb } : { kind: null, reason: gpu.reason },
      nativeMic: micCancelsEcho(),
      calendar: calendarOf(null, machine.calendarBackend, machine.googleClient),
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

/** The modifier Electron reads as ⌘ on macOS and as Ctrl on Windows, as Windows writes it. */
const WINDOWS_MODIFIERS: Record<string, string> = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl' }

/** An Electron accelerator as this OS writes a shortcut: ⌥Space or ⌘S on macOS, Alt+Shift+Space or Ctrl+S on Windows. */
export function shortcutLabel(os: OsFamily, accelerator: string): string {
  const parts = accelerator.split('+')
  if (os === 'windows') return parts.map((part) => WINDOWS_MODIFIERS[part] ?? part).join('+')
  return parts.map((part) => MAC_MODIFIERS[part] ?? part).join('')
}
