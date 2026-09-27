import { describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { nvidiaGpuSupport } from '@shared/nvidia-gpu'
import { deriveCapabilities, shortcutLabel, type Machine } from '@shared/platform'

const GIB = 1024 ** 3
const unasked = (): boolean => {
  throw new Error('the microphone check runs on Windows alone')
}

/**
 * A machine whose nvidia-smi printed this, or could not run at all for null. Its microphone check is
 * given only where a test is about it.
 */
const machine = (
  platform: string,
  arch: string,
  nvidiaSmi: string | null = null,
  totalMemoryBytes = 16 * GIB,
  micCancelsEcho: () => boolean = platform === 'win32' ? () => false : unasked
): Machine => ({
  platform,
  arch,
  totalMemoryBytes,
  nvidiaGpu: () => nvidiaGpuSupport(nvidiaSmi),
  micCancelsEcho,
  calendarBackend: undefined,
  googleClient: () => false
})

describe('what a machine can run', () => {
  it('gives an Apple Silicon Mac the MLX runtime with its memory, the native microphone without a check, the calendar and Alt+Space', () => {
    expect(deriveCapabilities(machine('darwin', 'arm64'))).toEqual({
      os: 'macos',
      speechRuntime: { kind: 'mlx', memoryGb: 16 },
      nativeMic: true,
      calendar: 'eventkit',
      hotkey: 'Alt+Space'
    })
  })

  it('counts the memory in whole GB the way the recommendations read it', () => {
    const memory = (bytes: number) => deriveCapabilities(machine('darwin', 'arm64', null, bytes)).speechRuntime
    expect(memory(15.7 * GIB)).toEqual({ kind: 'mlx', memoryGb: 16 })
    expect(memory(0.2 * GIB)).toEqual({ kind: 'mlx', memoryGb: 1 })
  })

  it('never runs nvidia-smi on a Mac', () => {
    const nvidiaGpu = vi.fn(() => nvidiaGpuSupport(null))
    deriveCapabilities({ ...machine('darwin', 'arm64'), nvidiaGpu })
    expect(nvidiaGpu).not.toHaveBeenCalled()
  })

  it('gives x64 Windows with a usable NVIDIA GPU the CUDA runtime with the memory of that GPU, and none of the Mac-only helpers', () => {
    expect(deriveCapabilities(machine('win32', 'x64', 'NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5\r\n', 32 * GIB))).toEqual({
      os: 'windows',
      speechRuntime: { kind: 'cuda', memoryGb: 8 },
      nativeMic: false,
      calendar: null,
      hotkey: expect.any(String)
    })
    expect(deriveCapabilities(machine('win32', 'x64', 'NVIDIA GeForce RTX 2060, 6144, 581.29, 7.5')).speechRuntime).toEqual({ kind: 'cuda', memoryGb: 6 })
  })

  it.each([
    ['nvidia-smi could not run', null, 'no-nvidia-gpu'],
    ['nvidia-smi listed no GPU', '', 'no-nvidia-gpu'],
    ['the only GPU is a GTX 1080', 'NVIDIA GeForce GTX 1080, 8192, 581.57, 6.1', 'gpu-too-old'],
    ['the driver is older than 580', 'NVIDIA GeForce RTX 3060, 12288, 572.83, 8.6', 'driver-too-old']
  ])('gives x64 Windows no local speech runtime when %s, with the reason', (_case, nvidiaSmi, reason) => {
    expect(deriveCapabilities(machine('win32', 'x64', nvidiaSmi)).speechRuntime).toEqual({ kind: null, reason })
  })

  it('gives x64 Windows the native microphone exactly when its check finds echo cancellation on, asking once', () => {
    for (const cancelsEcho of [true, false]) {
      const micCancelsEcho = vi.fn(() => cancelsEcho)
      expect(deriveCapabilities(machine('win32', 'x64', null, 32 * GIB, micCancelsEcho)).nativeMic).toBe(cancelsEcho)
      expect(micCancelsEcho).toHaveBeenCalledOnce()
    }
  })

  it('gives both systems Google Calendar when ASIST_CALENDAR_BACKEND asks for it and the build has the OAuth client', () => {
    const google = { calendarBackend: 'google', googleClient: () => true }
    expect(deriveCapabilities({ ...machine('darwin', 'arm64'), ...google }).calendar).toBe('google')
    expect(deriveCapabilities({ ...machine('win32', 'x64'), ...google }).calendar).toBe('google')
    // An empty value is the variable left blank in .env, which keeps each system's own calendar.
    expect(deriveCapabilities({ ...machine('darwin', 'arm64'), calendarBackend: '', googleClient: () => true }).calendar).toBe('eventkit')
    expect(deriveCapabilities({ ...machine('win32', 'x64'), calendarBackend: '', googleClient: () => true }).calendar).toBeNull()
  })

  it.each([
    ['darwin', 'arm64'],
    ['win32', 'x64']
  ])('stops the launch on %s %s when Google Calendar is asked for without the OAuth client', (platform, arch) => {
    expect(() => deriveCapabilities({ ...machine(platform, arch), calendarBackend: 'google', googleClient: () => false })).toThrow(
      errorText('app.startup.googleClientMissing', { variable: 'ASIST_CALENDAR_BACKEND' })
    )
  })

  it('stops the launch on a value of ASIST_CALENDAR_BACKEND it does not know, rather than keep the default calendar', () => {
    expect(() => deriveCapabilities({ ...machine('win32', 'x64'), calendarBackend: 'eventkit', googleClient: () => true })).toThrow(
      errorText('app.startup.calendarBackendUnknown', { variable: 'ASIST_CALENDAR_BACKEND', value: 'eventkit' })
    )
  })

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64']
  ])('refuses %s on %s, which the app is not built for', (platform, arch) => {
    expect(() => deriveCapabilities(machine(platform, arch))).toThrow(errorText('app.startup.unsupportedPlatform', { platform, arch }))
  })
})

describe('the label of a shortcut', () => {
  it('writes the modifiers as macOS menus do on a Mac and spells the accelerator out on Windows', () => {
    expect(shortcutLabel('macos', 'Alt+Space')).toBe('⌥Space')
    expect(shortcutLabel('macos', 'Ctrl+Shift+Space')).toBe('⌃⇧Space')
    expect(shortcutLabel('windows', 'Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space')
  })

  it('writes the modifier that is ⌘ on a Mac as Ctrl on Windows', () => {
    expect(shortcutLabel('macos', 'CommandOrControl+S')).toBe('⌘S')
    expect(shortcutLabel('windows', 'CommandOrControl+S')).toBe('Ctrl+S')
  })
})
