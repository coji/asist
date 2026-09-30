import { describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { deriveCapabilities, shortcutLabel, type Machine } from '@shared/platform'
import type { SpeechDevice } from '@shared/speech-devices'

const GIB = 1024 ** 3
const unasked = (): boolean => {
  throw new Error('the microphone check runs on Windows alone')
}

const gpu = (name: string, description: string, memoryGb: number, kind: SpeechDevice['kind'] = 'gpu'): SpeechDevice =>
  ({ name, description, kind, memoryTotal: memoryGb * GIB })
const CPU = gpu('CPU', 'Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz', 32, 'cpu')

/**
 * A machine whose device list is this, or failed when null. Its microphone check is given only where a
 * test is about it.
 */
const machine = (
  platform: string,
  arch: string,
  devices: SpeechDevice[] | null = [CPU],
  totalMemoryBytes = 16 * GIB,
  micCancelsEcho: () => boolean = platform === 'win32' ? () => false : unasked
): Machine => ({
  platform,
  arch,
  totalMemoryBytes,
  speechDevices: () => devices,
  micCancelsEcho
})

describe('what a machine can run', () => {
  it('gives an Apple Silicon Mac the local speech on Metal with its memory, the native microphone without a check and Alt+Space', () => {
    expect(deriveCapabilities(machine('darwin', 'arm64'))).toEqual({
      os: 'macos',
      localSpeech: { backend: 'metal', device: 'MTL0', memoryGb: 16 },
      nativeMic: true,
      hotkey: 'Alt+Space'
    })
  })

  it('counts the memory in whole GB the way the recommendations read it', () => {
    const memory = (bytes: number) => deriveCapabilities(machine('darwin', 'arm64', [], bytes)).localSpeech
    expect(memory(15.7 * GIB)).toEqual({ backend: 'metal', device: 'MTL0', memoryGb: 16 })
    expect(memory(0.2 * GIB)).toEqual({ backend: 'metal', device: 'MTL0', memoryGb: 1 })
  })

  it('never lists the devices on a Mac', () => {
    const speechDevices = vi.fn(() => [CPU])
    deriveCapabilities({ ...machine('darwin', 'arm64'), speechDevices })
    expect(speechDevices).not.toHaveBeenCalled()
  })

  it('gives x64 Windows with a discrete GPU the local speech on Vulkan on that GPU with its memory, and none of the Mac-only helpers', () => {
    expect(deriveCapabilities(machine('win32', 'x64', [gpu('Vulkan0', 'NVIDIA GeForce RTX 2080', 8), CPU], 32 * GIB))).toEqual({
      os: 'windows',
      localSpeech: { backend: 'vulkan', device: 'Vulkan0', memoryGb: 8 },
      nativeMic: false,
      hotkey: expect.any(String)
    })
  })

  it('runs the local speech on the discrete GPU with the most memory, never on an integrated one', () => {
    const devices = [gpu('Vulkan0', 'Intel(R) UHD Graphics 770', 16, 'igpu'), gpu('Vulkan1', 'NVIDIA GeForce RTX 3060', 12), gpu('Vulkan2', 'AMD Radeon RX 7900 XTX', 24), CPU]
    expect(deriveCapabilities(machine('win32', 'x64', devices)).localSpeech).toEqual({ backend: 'vulkan', device: 'Vulkan2', memoryGb: 24 })
  })

  it.each([
    ['only an integrated GPU and the CPU are listed', [gpu('Vulkan0', 'Intel(R) Iris(R) Xe Graphics', 16, 'igpu'), CPU], 'no-discrete-gpu'],
    ['only the CPU is listed', [CPU], 'no-discrete-gpu'],
    ['the device list could not be read', null, 'gpu-check-failed']
  ])('gives x64 Windows no local speech when %s, with the reason', (_case, devices, reason) => {
    expect(deriveCapabilities(machine('win32', 'x64', devices)).localSpeech).toEqual({ backend: null, reason })
  })

  it('gives x64 Windows the native microphone exactly when its check finds echo cancellation on, asking once', () => {
    for (const cancelsEcho of [true, false]) {
      const micCancelsEcho = vi.fn(() => cancelsEcho)
      expect(deriveCapabilities(machine('win32', 'x64', [CPU], 32 * GIB, micCancelsEcho)).nativeMic).toBe(cancelsEcho)
      expect(micCancelsEcho).toHaveBeenCalledOnce()
    }
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
