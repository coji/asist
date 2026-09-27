import { vi } from 'vitest'

/**
 * Main's own capabilities run nvidia-smi and, on Windows, open the real microphone to check its echo
 * cancellation, which a test must not do. Every test file therefore sees the fixture of the system it runs
 * on, whose real git and processes the agent and memory tests use, and a test that needs another machine
 * mocks the module again.
 */
vi.mock('../../src/main/services/platform', async () => {
  const { HOST } = await import('../helpers/platform')
  return { platformCapabilities: () => HOST }
})
