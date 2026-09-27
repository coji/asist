import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, launchChrome, sleep } from '../../scripts/cdp/cdp.mjs'

/**
 * Writes og.html, the card social sites show for the website, to public/img/og.png at 1200×630, or with
 * `en` to public/img/og-en.png with the English heading, which every language other than Japanese uses.
 */

/** The heading and the line below it in each language other than og.html's Japanese. */
const TEXT = {
  en: { heading: 'Just talk, and<br /><mark>your schedule and mail</mark><br />get handled.', sub: 'A realtime assistant for Mac and Windows' }
}
const language = process.argv[2]
if (language && !TEXT[language]) throw new Error(`og/render.mjs has no text for ${language}`)

const here = import.meta.dirname
const { port } = await launchChrome()
const page = await connect(port)
await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
await page.navigate(pathToFileURL(resolve(here, 'og.html')).href)
while ((await page.evaluate('document.readyState')) !== 'complete') await sleep(100)
if (language) {
  await page.evaluate(`document.documentElement.lang = ${JSON.stringify(language)}; document.querySelector('h1').innerHTML = ${JSON.stringify(TEXT[language].heading)}; document.querySelector('.copy p').textContent = ${JSON.stringify(TEXT[language].sub)}; 0`)
}
// The headings use Google Fonts; a capture before they load falls back to the system's rounded font.
await page.evaluate('document.fonts.ready.then(() => document.fonts.check("900 46px \\"Zen Maru Gothic\\""))').then((loaded) => {
  if (!loaded) throw new Error('Zen Maru Gothic did not load; og.html needs the network for Google Fonts')
})
const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
const out = resolve(here, `../public/img/${language ? `og-${language}` : 'og'}.png`)
writeFileSync(out, Buffer.from(data, 'base64'))
console.log(out)
process.exit(0)
