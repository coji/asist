import { closeSync, openSync, writeSync } from 'node:fs'
import { PHOTO } from './photos.mjs'
import { escapeXml, heading, paragraph, random, sentence, title } from './text.mjs'

/**
 * A PDF as Chrome's "Save as PDF" writes one: Skia's page tree, balanced with eight pages under each node, the
 * Japanese fonts embedded as subsets, and each photo's JPEG embedded as it is (DCTDecode). Every page is one A4
 * sheet of a report: a heading, prose, a table now and then, and a photo on every `photoEvery`-th page. The photos
 * are loaded but never decoded, since Skia embeds a JPEG as it is: decoded, the 500 photos of 1,000 pages with a
 * photo on every other one (237 MB, printed in 41 s on an M5 on 2026-10-02) would hold 3.8 GB of pixels.
 */

const STYLE = `
@page { size: A4; margin: 18mm }
body { margin: 0; font: 10.5pt/1.75 "Hiragino Mincho ProN", "Yu Mincho", serif; color: #222 }
section { height: 258mm; overflow: hidden }
section + section { break-before: page }
h1, h2, figcaption, th { font-family: "Hiragino Sans", "Yu Gothic", sans-serif }
h1 { font-size: 20pt; margin: 0 0 4mm }
h2 { font-size: 13pt; margin: 0 0 3mm }
p { margin: 0 0 2.5mm; text-indent: 1em }
figure { margin: 0 0 4mm }
img { display: block; width: 100%; height: 95mm; object-fit: cover }
figcaption { font-size: 9pt; color: #555; margin-top: 1.5mm }
table { border-collapse: collapse; width: 100%; margin: 0 0 4mm; font-size: 9pt }
th, td { border: 0.5pt solid #888; padding: 1mm 2mm; text-align: right }
`

/** The pages handed to the page in one evaluation. */
const BATCH = 50

function pageHtml(next, number, { photoEvery }) {
  const parts = []
  if (number % 10 === 1) parts.push(`<h1>${escapeXml(heading(next, Math.ceil(number / 10)))}</h1>`)
  parts.push(`<h2>${number}. ${escapeXml(title(next))}</h2>`)
  const withPhoto = number % photoEvery === 1 || photoEvery === 1
  if (withPhoto) parts.push(`<figure><img data-seed="${number}"><figcaption>図 ${number}. ${escapeXml(sentence(next))}</figcaption></figure>`)
  if (number % 7 === 0) {
    const rows = Array.from({ length: 5 }, (_, i) => `<tr><td>${2021 + i}</td>${Array.from({ length: 4 }, () => `<td>${Math.floor(next() * 90_000).toLocaleString('en-US')}</td>`).join('')}</tr>`)
    parts.push(`<table><tr><th>年度</th><th>東日本</th><th>西日本</th><th>海外</th><th>合計</th></tr>${rows.join('')}</table>`)
  }
  for (let i = 0; i < (withPhoto ? 4 : 9); i++) parts.push(`<p>${escapeXml(paragraph(next, 3 + Math.floor(next() * 2)))}</p>`)
  return `<section>${parts.join('')}</section>`
}

/** Writes a PDF of `pages` pages from the blank page of a Chrome where PHOTO_SCRIPT has run. */
export async function writePdf(client, file, { pages, photoEvery, title: documentTitle }) {
  const next = random(pages)
  await client.evaluate(`(() => {
    document.title = ${JSON.stringify(documentTitle)}
    document.head.innerHTML += ${JSON.stringify(`<style>${STYLE}</style>`)}
    document.body.replaceChildren()
    return null
  })()`)
  for (let start = 1; start <= pages; start += BATCH) {
    const html = Array.from({ length: Math.min(BATCH, pages - start + 1) }, (_, i) => pageHtml(next, start + i, { photoEvery })).join('')
    await client.evaluate(`(async () => {
      const holder = document.createElement('div')
      holder.innerHTML = ${JSON.stringify(html)}
      const images = [...holder.querySelectorAll('img[data-seed]')]
      for (const img of images) img.src = URL.createObjectURL(await window.makePhoto(Number(img.dataset.seed), ${JSON.stringify(PHOTO.pdf)}))
      document.body.append(...holder.children)
      await Promise.all(images.map((img) => (img.complete ? null : new Promise((resolve, reject) => ((img.onload = resolve), (img.onerror = reject))))))
      return null
    })()`)
  }
  const { stream } = await client.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, transferMode: 'ReturnAsStream' })
  const fd = openSync(file, 'w')
  try {
    for (;;) {
      const { data, eof, base64Encoded } = await client.send('IO.read', { handle: stream, size: 4 * 1024 * 1024 })
      writeSync(fd, Buffer.from(data, base64Encoded ? 'base64' : 'utf8'))
      if (eof) break
    }
  } finally {
    closeSync(fd)
    await client.send('IO.close', { handle: stream })
  }
}
