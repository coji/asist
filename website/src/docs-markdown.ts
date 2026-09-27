const SITE = 'https://asist-agent.com'

/** Starlight's aside types, as GitHub's alert names; GitHub's CAUTION is the stronger of its two warnings. */
const ALERTS: Record<string, string> = { note: 'NOTE', tip: 'TIP', caution: 'WARNING', danger: 'CAUTION' }

/** The components that wrap a block of Markdown, each on lines of its own. */
const BLOCKS = new Set(['Tabs', 'TabItem', 'Steps', 'CardGrid', 'Aside'])

const indentOf = (line: string): number => line.length - line.trimStart().length

const attributesOf = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))

const absolute = (href: string): string => (href.startsWith('/') ? `${SITE}${href}` : href)

/**
 * Moves the lines inside a component to the column of its opening tag. MDX drops the indentation of a
 * component's children, while in Markdown four more spaces turn a paragraph into a code block.
 */
function dedent(lines: string[], column: number): string[] {
  const filled = lines.filter((line) => line.trim())
  const extra = filled.length ? Math.min(...filled.map(indentOf)) - column : 0
  return extra > 0 ? lines.map((line) => line.slice(Math.min(extra, indentOf(line)))) : lines
}

function convert(lines: string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (fence) {
      out.push(line)
      if (trimmed === fence) fence = null
      continue
    }
    const opening = /^(`{3,}|~{3,})/.exec(trimmed)
    if (opening) {
      fence = opening[1]
      out.push(line)
      continue
    }
    if (/^import .+ from '.+'$/.test(trimmed)) continue
    const column = ' '.repeat(indentOf(line))
    const card = /^<LinkCard\s[^>]*\/>$/.exec(trimmed)
    if (card) {
      const { title, description, href } = attributesOf(trimmed)
      out.push(`${column}- [${title}](${absolute(href)})${description ? `: ${description}` : ''}`)
      continue
    }
    const block = /^<([A-Z]\w*)(\s[^>]*)?>$/.exec(trimmed)
    if (block && BLOCKS.has(block[1])) {
      const [, name] = block
      let depth = 1
      let end = i + 1
      for (; end < lines.length; end++) {
        const inner = lines[end].trim()
        if (new RegExp(`^<${name}(\\s[^>]*)?>$`).test(inner)) depth++
        if (inner === `</${name}>` && --depth === 0) break
      }
      if (end === lines.length) throw new Error(`<${name}> on line ${i + 1} is not closed`)
      const children = convert(dedent(lines.slice(i + 1, end), column.length))
      const attributes = attributesOf(trimmed)
      if (name === 'TabItem') out.push('', `${column}**${attributes.label}**`, '', ...children)
      else if (name === 'Aside') {
        const alert = ALERTS[attributes.type ?? 'note']
        if (!alert) throw new Error(`<Aside type="${attributes.type}"> has no GitHub alert`)
        const quoted = [`[!${alert}]`, ...(attributes.title ? [`**${attributes.title}**`] : []), ...children.map((child) => child.slice(column.length))]
        out.push(...quoted.map((child) => (child.trim() ? `${column}> ${child}` : `${column}>`)))
      } else out.push(...children)
      i = end
      continue
    }
    const component = /<([A-Z]\w*)/.exec(line.replace(/`[^`]*`/g, ''))
    if (component) throw new Error(`<${component[1]}> on line ${i + 1} has no Markdown form`)
    out.push(line.replace(/(\]\()\//g, `$1${SITE}/`))
  }
  return out
}

/**
 * A documentation page as plain Markdown, for readers who paste it into a model or read it as text:
 * Starlight's components become lists, bold labels and GitHub alerts, and links point to asist-agent.com.
 * A component with no Markdown form stops the build rather than leaving its tag in the text.
 */
export function docsMarkdown(page: { title: string; description?: string; body: string }): string {
  const body = convert(page.body.split('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return `# ${page.title}\n\n${page.description ? `${page.description}\n\n` : ''}${body}\n`
}
