import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The setImmediate the preview page gives the JSZip inside mammoth, which waits with a clamped setTimeout(0)
 * between two steps of its work where it finds none. Node has its own, so the test takes it away first.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("the preview page's setImmediate", () => {
  it('runs each callback once, with its arguments and in the order they were given, without a timeout', async () => {
    vi.stubGlobal('setImmediate', undefined)
    const timeout = vi.fn()
    vi.stubGlobal('setTimeout', timeout)
    await import('@/preview/set-immediate')
    const scope = globalThis as unknown as { setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void }
    const calls: unknown[][] = []
    await new Promise<void>((resolve) => {
      for (let i = 0; i < 100; i++) scope.setImmediate((...args) => calls.push(args), i, `step ${i}`)
      scope.setImmediate(() => resolve())
    })
    expect(calls).toEqual(Array.from({ length: 100 }, (_, i) => [i, `step ${i}`]))
    expect(timeout).not.toHaveBeenCalled()
  })
})
