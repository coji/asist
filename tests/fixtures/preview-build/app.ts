import { shared } from './shared'

console.log(shared('app'))
new Worker(new URL('./app-worker.ts', import.meta.url), { type: 'module' })
