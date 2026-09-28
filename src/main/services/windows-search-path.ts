import path from 'node:path'

const isQuote = (char: string | undefined): boolean => char === '"' || char === "'"

/**
 * The folders of a Windows PATH value, in order, read as libuv's search_path reads them (src/win/process.c),
 * which is how Node's spawn finds a program on Windows. A quote counts only where an entry begins: from
 * there the entry runs to the same quote and then to the next `;`, and an unclosed one runs to the end of
 * the value. One quote is then dropped from each end of the entry. Nothing is trimmed. Unlike libuv, an
 * empty entry and a relative folder, which libuv searches from the current folder, are left out.
 */
export function windowsPathFolders(value: string): string[] {
  const folders: string[] = []
  let end = 0
  while (end < value.length) {
    if (value[end] === ';') end++
    const start = end
    if (isQuote(value[start])) {
      const close = value.indexOf(value[start], start + 1)
      end = close === -1 ? value.length : close
    }
    const separator = value.indexOf(';', end)
    end = separator === -1 ? value.length : separator
    let folder = value.slice(start, end)
    if (isQuote(folder[0])) folder = folder.slice(1)
    if (isQuote(folder.at(-1))) folder = folder.slice(0, -1)
    if (folder !== '' && path.win32.isAbsolute(folder)) folders.push(folder)
  }
  return folders
}
