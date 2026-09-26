/**
 * Path handling for shared and renderer code, which cannot import node:path. A path reaches them as the
 * OS wrote it, and its form decides the rules: a path in a Windows form, starting with a drive letter or
 * "\" as in \\server\share, takes both separators as Windows does, and every other path follows the POSIX
 * rules, where "\" is part of a name. Each function gives what path.posix or path.win32 gives for its form.
 */

const DRIVE = /^[A-Za-z]:/
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/])/

/** Whether p is written in a Windows form: a drive letter, or "\" as in \\server\share and \folder. */
const isWindowsForm = (p: string): boolean => DRIVE.test(p) || p.startsWith('\\')

type SeparatorTest = (char: string | undefined) => boolean

const posixSeparator: SeparatorTest = (char) => char === '/'
const windowsSeparator: SeparatorTest = (char) => char === '/' || char === '\\'

const separatorOf = (p: string): SeparatorTest => (isWindowsForm(p) ? windowsSeparator : posixSeparator)

/**
 * How many characters of p name its root. POSIX has "/" alone; Windows has a drive such as "C:" or "C:\",
 * "\\server\share\" with the separator after the share, and "\" for the root of the current drive.
 */
function rootLength(p: string): number {
  if (!isWindowsForm(p)) return p.startsWith('/') ? 1 : 0
  if (DRIVE.test(p)) return windowsSeparator(p[2]) ? 3 : 2
  const unc = /^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]?/.exec(p)
  return unc ? unc[0].length : 1
}

/** Whether p names a place without depending on a current folder or a current drive. */
export function isAbsolutePath(p: string): boolean {
  return ABSOLUTE.test(p)
}

/** p without the separators at its end, except those that belong to its root, so "/" and "C:\" stay as they are. */
export function trimTrailingSeparator(p: string): string {
  const isSeparator = separatorOf(p)
  const root = rootLength(p)
  let end = p.length
  while (end > root && isSeparator(p[end - 1])) end--
  return p.slice(0, end)
}

/** The last name in p, as path.basename gives it. */
export function baseName(p: string): string {
  const isSeparator = separatorOf(p)
  let start = isWindowsForm(p) && DRIVE.test(p) ? 2 : 0
  let end = -1
  for (let i = p.length - 1; i >= start; i--) {
    if (!isSeparator(p[i])) {
      if (end === -1) end = i + 1
    } else if (end !== -1) {
      start = i + 1
      break
    }
  }
  return end === -1 ? '' : p.slice(start, end)
}

/**
 * The folder that holds p: exactly what path.posix.dirname gives for a POSIX path, and for a Windows path
 * the root for a name directly under it and otherwise the beginning of p up to the separators before the
 * last name. A single relative name gives ".".
 */
export function dirName(p: string): string {
  if (!isWindowsForm(p)) return posixDirName(p)
  const root = rootLength(p)
  let end = trimTrailingSeparator(p).length
  while (end > root && !windowsSeparator(p[end - 1])) end--
  while (end > root && windowsSeparator(p[end - 1])) end--
  return p.slice(0, end)
}

/** path.posix.dirname, including its "//" for a name under a path that starts with two slashes. */
function posixDirName(p: string): string {
  if (p === '') return '.'
  const hasRoot = p.startsWith('/')
  let end = -1
  let afterName = false
  for (let i = p.length - 1; i >= 1; i--) {
    if (p[i] !== '/') afterName = true
    else if (afterName) {
      end = i
      break
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  return hasRoot && end === 1 ? '//' : p.slice(0, end)
}

/** The names in p after its root, in order, leaving out the empty ones between repeated separators. */
export function pathNames(p: string): string[] {
  const isSeparator = separatorOf(p)
  const names: string[] = []
  let name = ''
  for (const char of p.slice(rootLength(p))) {
    if (!isSeparator(char)) name += char
    else if (name) {
      names.push(name)
      name = ''
    }
  }
  if (name) names.push(name)
  return names
}

/** The separator p is shown with: "\" for a path in a Windows form and "/" for any other. */
export function displaySeparator(p: string): string {
  return isWindowsForm(p) ? '\\' : '/'
}

/**
 * Whether two absolute paths name the same place as written. Two paths in a Windows form compare without
 * regard to the separator or the letter case, as Windows matches names; any other pair compares exactly.
 * Neither side is looked up on disk, so a link and its target differ.
 */
export function samePath(a: string, b: string): boolean {
  const left = trimTrailingSeparator(a)
  const right = trimTrailingSeparator(b)
  if (!isWindowsForm(left) || !isWindowsForm(right)) return left === right
  const folded = (p: string): string => p.replace(/\//g, '\\').toLowerCase()
  return folded(left) === folded(right)
}

/**
 * The part of p below the folder root, without separators at either end: "" for root itself, and null
 * for a path outside it, including one whose name only begins like root's last name. The two are
 * compared as samePath compares them.
 */
export function pathInside(root: string, p: string): string | null {
  const isSeparator = separatorOf(root)
  const base = trimTrailingSeparator(root)
  if (!samePath(p.slice(0, base.length), base)) return null
  const rest = p.slice(base.length)
  if (rest !== '' && !isSeparator(rest[0]) && !isSeparator(base[base.length - 1])) return null
  let start = 0
  while (isSeparator(rest[start])) start++
  return trimTrailingSeparator(rest.slice(start))
}
