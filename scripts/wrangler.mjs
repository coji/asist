import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Runs wrangler with its login kept inside this checkout, in .wrangler/config, so that the Cloudflare
 * account of ASIST's website stays apart from the account wrangler is logged in to elsewhere on this Mac.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// wrangler reads ~/.wrangler in preference to XDG_CONFIG_HOME whenever that folder exists, and would then
// deploy with the other account.
if (fs.existsSync(path.join(os.homedir(), '.wrangler'))) {
  console.error('wrangler: ~/.wrangler exists, and wrangler would use its login instead of this repository\'s. Move it away first.')
  process.exit(1)
}

const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, '.wrangler', 'config') }
// A token or an account in the environment takes precedence over the login, whichever account it belongs to.
delete env.CLOUDFLARE_API_TOKEN
delete env.CLOUDFLARE_API_KEY
delete env.CLOUDFLARE_EMAIL
delete env.CLOUDFLARE_ACCOUNT_ID

// wrangler's own script is run with this node, since the launcher in .bin is a .cmd on Windows, which Node
// does not spawn without a shell.
const wrangler = path.join(root, 'website', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const result = spawnSync(process.execPath, [wrangler, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
process.exit(result.status ?? 1)
