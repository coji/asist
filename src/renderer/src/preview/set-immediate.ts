/**
 * setImmediate for the preview page, which a browser does not have, imported ahead of the library that looks for
 * it. The JSZip that mammoth bundles hands data on 16 KB at a time and waits between two steps with setImmediate
 * where one exists, and otherwise with setTimeout(0), which Chromium holds for at least 4 ms once nested.
 * Converting a 300-page report without its pictures took 493 such steps and 2.3 s, nearly all of it waiting
 * (headless Chrome on an M5, 2026-10-02). A message on a channel of the page's own runs as soon as the page is
 * free, and a channel leaves the window's own messages, which the page takes its port from, alone.
 */

const scope = globalThis as { setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void }

if (scope.setImmediate === undefined) {
  const channel = new MessageChannel()
  const queue: Array<() => void> = []
  channel.port1.onmessage = () => queue.shift()!()
  scope.setImmediate = (callback, ...args) => {
    queue.push(() => callback(...args))
    channel.port2.postMessage(null)
  }
}
