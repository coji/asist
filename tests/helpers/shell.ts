import fs from 'node:fs'
import path from 'node:path'

/**
 * A stand-in for the user's login shell, for a test that launches an agent CLI on macOS without running the
 * startup files of whoever runs the tests: it runs the command after -c with the PATH it was started with.
 * Set it as SHELL.
 */
export function fakeLoginShell(folder: string): string {
  const shell = path.join(folder, 'login-shell')
  fs.writeFileSync(shell, '#!/bin/sh\nwhile [ "$1" != -c ]; do shift; done\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
  return shell
}
