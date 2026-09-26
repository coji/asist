import { describe, expect, it } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { deriveCapabilities, hotkeyLabel } from '@shared/platform'

const GIB = 1024 ** 3

describe('what a machine can run', () => {
  it('gives an Apple Silicon Mac the MLX runtime with its memory, the native microphone, the Python workers, the calendar and Alt+Space', () => {
    expect(deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 16 * GIB })).toEqual({
      os: 'macos',
      speechRuntime: { kind: 'mlx', memoryGb: 16 },
      nativeMic: true,
      cpuSidecars: true,
      calendar: true,
      hotkey: 'Alt+Space'
    })
  })

  it('counts the memory in whole GB the way the recommendations read it', () => {
    const memory = (bytes: number) => deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: bytes }).speechRuntime
    expect(memory(15.7 * GIB)).toEqual({ kind: 'mlx', memoryGb: 16 })
    expect(memory(0.2 * GIB)).toEqual({ kind: 'mlx', memoryGb: 1 })
  })

  it('gives x64 Windows no local speech runtime, with the reason, and none of the Mac-only helpers', () => {
    expect(deriveCapabilities({ platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * GIB })).toEqual({
      os: 'windows',
      speechRuntime: { kind: null, reason: 'unsupported-os' },
      nativeMic: false,
      cpuSidecars: false,
      calendar: false,
      hotkey: expect.any(String)
    })
  })

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64']
  ])('refuses %s on %s, which the app is not built for', (platform, arch) => {
    expect(() => deriveCapabilities({ platform, arch, totalMemoryBytes: 16 * GIB })).toThrow(
      errorText('app.startup.unsupportedPlatform', { platform, arch })
    )
  })
})

describe('the label of the global hotkey', () => {
  it('writes the modifiers as macOS menus do on a Mac and spells the accelerator out on Windows', () => {
    expect(hotkeyLabel({ os: 'macos', hotkey: 'Alt+Space' })).toBe('⌥Space')
    expect(hotkeyLabel({ os: 'macos', hotkey: 'Ctrl+Shift+Space' })).toBe('⌃⇧Space')
    expect(hotkeyLabel({ os: 'windows', hotkey: 'Ctrl+Alt+Space' })).toBe('Ctrl+Alt+Space')
  })
})
