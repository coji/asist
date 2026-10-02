export function start(): Worker {
  return new Worker(new URL('./preview-worker.ts', import.meta.url), { type: 'module' })
}
