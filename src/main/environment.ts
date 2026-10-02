import path from 'node:path'
import { app } from 'electron'
import dotenv from 'dotenv'
import { errorText } from '@shared/i18n/error-text'

// Runs as the first dependency of index.ts, before any service that reads a setting or an endpoint. Only a
// development launch reads the .env of its working directory, and the parent process's environment wins
// over it. A packaged app never reads one, wherever it is started from, because a .env in a folder such as a
// cloned repository would otherwise choose its endpoints and the API keys its conversation is sent with.
if (!app.isPackaged) {
  const file = path.join(process.cwd(), '.env')
  const result = dotenv.config({ path: file, override: false, quiet: true })
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw new Error(errorText('app.startup.envUnreadable', { file, detail: result.error.message }), { cause: result.error })
  }
}
