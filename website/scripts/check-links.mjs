import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Checks every link and image inside the built site (website/dist): each internal href or src must reach a
 * built file, and each #fragment must name an id on the page it points to. External links are not fetched.
 * Every screenshot under /screens/ must also be shown by some page, since npm run demo:docs-shots writes
 * each of them for a page and one no page shows is left behind. Exits with 1 and lists what is wrong.
 */

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const pages = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.html')) pages.push(full)
  }
})(dist)

const idsOf = new Map()
const ids = (file) => {
  if (!idsOf.has(file)) {
    const html = fs.readFileSync(file, 'utf8')
    idsOf.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])))
  }
  return idsOf.get(file)
}

/** The built file a site path reaches, as the Worker's asset handling serves it, or null. */
function fileOf(sitePath) {
  const clean = decodeURIComponent(sitePath)
  const candidates = clean.endsWith('/') ? [path.join(dist, clean, 'index.html')] : [path.join(dist, clean), path.join(dist, clean, 'index.html'), path.join(dist, `${clean}.html`)]
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null
}

const broken = []
const shown = new Set()
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8')
  const pagePath = '/' + path.relative(dist, page).replace(/index\.html$/, '').replace(/\\/g, '/')
  for (const [, attr, value] of html.matchAll(/\s(href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|data:|javascript:|\/\/)/.test(value)) continue
    const url = new URL(value.replace(/&amp;/g, '&'), `https://asist-agent.com${pagePath}`)
    const target = fileOf(url.pathname)
    if (target) shown.add(target)
    if (!target) {
      broken.push(`${pagePath}: ${attr}="${value}" reaches no file`)
      continue
    }
    const fragment = decodeURIComponent(url.hash.slice(1))
    if (fragment && target.endsWith('.html') && !ids(target).has(fragment)) {
      broken.push(`${pagePath}: ${attr}="${value}" names no heading #${fragment}`)
    }
  }
}

const screens = path.join(dist, 'screens')
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (!shown.has(full)) broken.push(`/${path.relative(dist, full).replace(/\\/g, '/')} is shown by no page`)
  }
})(screens)

if (broken.length) {
  console.error(`${broken.length} problem(s) in ${pages.length} pages:\n${broken.join('\n')}`)
  process.exit(1)
}
console.log(`links: all internal links and images of ${pages.length} pages reach their target, and every screenshot is shown`)
