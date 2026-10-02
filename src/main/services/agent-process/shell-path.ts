import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'
import { childEnv } from '../child-env'

/**
 * How long the user's shell may take to start and print its PATH. An interactive zsh that loads nvm and
 * pyenv answered in 0.55 to 0.7 s on an Apple Silicon Mac (2026-10-02); a startup file that waits on the
 * network or a slow disk takes longer, and one that never finishes must not hold a job forever.
 */
export const SHELL_ANSWER_TIMEOUT_MS = 10_000

/**
 * The PATH the user's shell builds, read from their $SHELL started as an interactive login shell, the way
 * a terminal starts it. An app opened from Finder or the Dock inherits launchd's /usr/bin:/bin:/usr/sbin:/sbin,
 * and nvm, bun and pnpm add their folders in ~/.zshrc, which zsh reads only when it is interactive.
 *
 * The startup files may print a greeting or a prompt, so the PATH is read between two markers. `echo` and
 * `;` mean the same in sh, bash, zsh and fish, and printenv prints PATH joined with colons even in fish,
 * whose own $PATH is a list. The shell runs in a session of its own with no terminal and no input, so a
 * startup file that reads from either gets nothing rather than waiting, and at the time limit the shell is
 * killed together with whatever its startup files started.
 */
export function readShellPath(): Promise<string> {
  const shell = process.env.SHELL ?? ''
  const marker = `asist-path-${randomUUID()}`
  // tcsh and csh refuse -l together with other options ("Unknown option: `-l'"), so they are asked as an
  // interactive shell alone, which reads ~/.tcshrc or ~/.cshrc, where their users set PATH.
  const flags = ['tcsh', 'csh'].includes(path.posix.basename(shell)) ? ['-i'] : ['-i', '-l']
  return new Promise((resolve, reject) => {
    const unread = (): Error => new Error(errorText('jobs.start.shellPathUnread', { shell }))
    let child: ChildProcess
    try {
      child = spawn(shell, [...flags, '-c', `echo ${marker}; /usr/bin/printenv PATH; echo ${marker}`], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: childEnv(),
        windowsHide: true
      })
    } catch {
      // An empty $SHELL fails the spawn at once rather than with an error event.
      reject(unread())
      return
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch (error) {
        // ESRCH is a group that ended on its own just before the time limit.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('the login shell could not be stopped:', error)
      }
      reject(unread())
    }, SHELL_ANSWER_TIMEOUT_MS)
    let output = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      output += chunk
      const start = output.indexOf(`${marker}\n`)
      const end = start < 0 ? -1 : output.indexOf(`\n${marker}`, start + marker.length)
      if (end < 0) return
      clearTimeout(timer)
      // A process the startup files left holding the pipe would otherwise keep it open after the answer.
      child.stdout!.destroy()
      const answer = output.slice(start + marker.length + 1, end)
      if (answer) resolve(answer)
      else reject(unread())
    })
    // Whatever ends the shell before it printed both markers, a missing program included, is a shell that did not answer.
    const ended = (): void => {
      clearTimeout(timer)
      reject(unread())
    }
    child.once('error', ended)
    child.once('close', ended)
  })
}
