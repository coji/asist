import path from 'node:path'

/**
 * Whether p names one place on a drive or a share, whatever the process's current folder and drive, which is
 * what a folder ASIST reads files under, starts a job in or remembers must be. On Windows, path.isAbsolute also
 * takes "\proj" and "/proj", which name a folder on the current drive, and the device and namespace forms
 * \\?\, \\.\ and \??\, which name no folder of the user's.
 */
export function isFullPath(p: string, paths: typeof path.posix = path): boolean {
  if (!paths.isAbsolute(p)) return false
  if (paths.sep === '/') return true
  const root = paths.parse(p).root
  if (/^[A-Za-z]:[\\/]$/.test(root)) return true
  const server = /^[\\/]{2}([^\\/]+)[\\/]+[^\\/]/.exec(root)?.[1]
  return server !== undefined && server !== '?' && server !== '.'
}
