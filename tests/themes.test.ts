import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEMES } from '@shared/themes'
import { MESSAGES } from '@shared/i18n'

const RENDERER = path.resolve(__dirname, '../src/renderer/src')
const ASSETS = path.join(RENDERER, 'assets')
const THEMES_CSS = path.join(ASSETS, 'themes.css')
/** Every theme but future lives in a folder of its own, beside its picture. */
const themeFile = (theme: string): string => path.join(ASSETS, 'themes', theme, 'theme.css')
const OTHER_THEMES = THEMES.filter((theme) => theme !== DEFAULT_THEME)

/**
 * The prefixes of the tokens a theme defines, read through var() or, by what draws on a canvas, as a quoted
 * name. Other custom properties, such as --wx-columns, belong to one component. A name built in a template,
 * such as var(--cal-event-${n}), ends in a hyphen and is left out.
 */
const THEME_TOKEN = /(?:var\(\s*|['"])(--(?:ui|card|cal|viewer|code|hud|boot|app|orb)-[\w-]+)/g

interface Block {
  selector: string
  declarations: string[]
}

/**
 * Splits a stylesheet into its top-level rules. A rule opened inside another one is reported, because CSS
 * nesting would read it as a descendant of the outer selector and its tokens would reach nothing.
 */
function topLevelBlocks(css: string): { blocks: Block[]; nested: string[] } {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: Block[] = []
  const nested: string[] = []
  let depth = 0
  let start = 0
  let selector = ''
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') {
      if (depth === 0) {
        selector = source.slice(start, i).trim()
        start = i + 1
      } else {
        nested.push(`${selector} > ${source.slice(source.lastIndexOf(';', i) + 1, i).trim()}`)
      }
      depth++
    } else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        const body = source.slice(start, i)
        const declarations = [...body.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
        blocks.push({ selector, declarations })
        start = i + 1
      }
    }
  }
  return { blocks, nested }
}

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${path.sep}demo${path.sep}`))
}

const mainSheet = readFileSync(THEMES_CSS, 'utf8')
const sheets = [mainSheet, ...OTHER_THEMES.filter((theme) => existsSync(themeFile(theme))).map((theme) => readFileSync(themeFile(theme), 'utf8'))]
const parsed = sheets.map(topLevelBlocks)
const themes = { blocks: parsed.flatMap((sheet) => sheet.blocks), nested: parsed.flatMap((sheet) => sheet.nested) }
/**
 * The tokens a theme may leave to future: the type and placement of card headings, which a theme changes only
 * when it wants a different look, and the pictures of all the themes, which the theme picker shows side by side.
 * Every colour, surface, radius and background has to be chosen by each theme, because a value of future left in
 * another theme is a dark patch in a light screen that nothing reports.
 */
const MAY_KEEP_FUTURE = /^--(card-(kicker|title|number|hero)-|app-picture-)/

/** The palette Tailwind reads, declared for future in main.css's @theme block. */
const PALETTE = [...readFileSync(path.join(RENDERER, 'assets/main.css'), 'utf8').matchAll(/^\s*(--color-holo-[\w-]+|--shadow-glass)\s*:/gm)].map((match) => match[1])

/** A rule that holds the value of future: any rule that does not name a theme, such as :root or the card frame. */
const isDefault = (selector: string): boolean => !selector.includes('[data-theme=')

describe('the theme stylesheet', () => {
  it('has no rule nested inside another, which would hide its tokens from every theme', () => {
    expect(themes.nested).toEqual([])
  })

  it('declares each token once per theme, so no value is silently overridden by a later section', () => {
    const seen = new Map<string, number>()
    for (const block of themes.blocks) {
      for (const token of block.declarations) {
        const key = `${block.selector} ${token}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
    expect([...seen].filter(([, count]) => count > 1).map(([key]) => key)).toEqual([])
  })

  it('gives every token a theme overrides a default value, so a theme cannot introduce a misspelled one', () => {
    const defaults = new Set(themes.blocks.filter((block) => isDefault(block.selector)).flatMap((block) => block.declarations))
    const overridden = themes.blocks
      .filter((block) => block.selector.startsWith(':root[data-theme='))
      .flatMap((block) => block.declarations.filter((token) => !token.startsWith('--color-holo-') && token !== '--shadow-glass'))
    expect(overridden.filter((token) => !defaults.has(token))).toEqual([])
  })
})

describe('each theme', () => {
  const declaredBy = (selector: string): Set<string> =>
    new Set(themes.blocks.filter((block) => block.selector === selector).flatMap((block) => block.declarations))
  const rootDefaults = [...new Set(themes.blocks.filter((block) => block.selector.split(',').some((part) => part.trim() === ':root')).flatMap((block) => block.declarations))]
  const frameDefaults = [...declaredBy('.panel-card, .panel-focus')]

  it.each(OTHER_THEMES)('%s has its own file, which themes.css imports', (theme) => {
    expect(existsSync(themeFile(theme))).toBe(true)
    expect(mainSheet).toContain(`@import './themes/${theme}/theme.css';`)
  })

  it.each(THEMES)('%s has a picture that exists, a prompt it was made from, and a name and description', (theme) => {
    const picture = themes.blocks
      .filter((block) => isDefault(block.selector))
      .some((block) => block.declarations.includes(`--app-picture-${theme}`))
    expect(picture).toBe(true)
    const url = mainSheet.match(new RegExp(`--app-picture-${theme}:\\s*url\\('([^']+)'\\)`))?.[1]
    expect(url && existsSync(path.join(ASSETS, url))).toBe(true)
    if (theme !== DEFAULT_THEME) {
      const prompts = JSON.parse(readFileSync(path.join(ASSETS, 'themes', 'prompts.json'), 'utf8')) as { prompts: Record<string, string> }
      expect(prompts.prompts[theme]).toBeTruthy()
    }
    expect(MESSAGES.settingsAppearance.themes).toHaveProperty([theme, 'name'])
    expect(MESSAGES.settingsAppearance.themes).toHaveProperty([theme, 'description'])
  })

  it.each(OTHER_THEMES)('%s chooses every colour, surface and picture itself', (theme) => {
    const own = declaredBy(`:root[data-theme='${theme}']`)
    const frame = declaredBy(`:root[data-theme='${theme}'] :is(.panel-card, .panel-focus)`)
    const missing = [
      ...[...PALETTE, ...rootDefaults].filter((token) => !MAY_KEEP_FUTURE.test(token) && !own.has(token)),
      ...frameDefaults.filter((token) => !frame.has(token)).map((token) => `card frame ${token}`)
    ]
    expect(missing).toEqual([])
  })
})

describe('the UI', () => {
  it('reads only theme tokens that are declared somewhere', () => {
    const declared = new Set<string>()
    for (const file of filesUnder(RENDERER, ['.css'])) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) declared.add(match[1])
    }
    const missing = new Set<string>()
    for (const file of filesUnder(RENDERER, ['.css', '.ts', '.tsx'])) {
      for (const match of readFileSync(file, 'utf8').matchAll(THEME_TOKEN)) {
        if (!match[1].endsWith('-') && !declared.has(match[1])) missing.add(`${path.relative(RENDERER, file)} ${match[1]}`)
      }
    }
    expect([...missing]).toEqual([])
  })

  it('writes no quoted hex colour and no functional colour notation with numbers in a renderer script', () => {
    const literal = /['"`]#[\da-f]{3,8}['"`]|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*\d/gi
    const found = filesUnder(RENDERER, ['.ts', '.tsx']).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(literal)].map((match) => `${path.relative(RENDERER, file)} ${match[0]}`)
    )
    expect(found).toEqual([])
  })
})
