/**
 * Photos for the generated documents, drawn and encoded as JPEG by the Chrome that writes the files: a sky, soft
 * shapes and grain, with no two alike. The grain is what brings a JPEG to the size of a real photo of the same
 * dimensions; without it a drawn picture compresses to a fraction of that. In headless Chrome on 2026-10-02 a
 * photo of the `pdf` kind came to about 450 KB, of the `slide` kind about 870 KB and of the `document` kind about
 * 600 KB.
 */
export const PHOTO = {
  /** A photo in a printed report. */
  pdf: { width: 1600, height: 1200, quality: 0.85, grain: 14 },
  /** A photo filling half of a slide, as taken by a phone and scaled down. */
  slide: { width: 2400, height: 1600, quality: 0.85, grain: 14 },
  /** A photo in a Word document. */
  document: { width: 2000, height: 1500, quality: 0.85, grain: 12 }
}

/** Defines window.makePhoto(seed, kind), which resolves to a JPEG Blob, in the page it is evaluated in. */
export const PHOTO_SCRIPT = `window.makePhoto = async (seed, { width, height, quality, grain }) => {
  let state = seed >>> 0 || 1
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const hue = Math.floor(random() * 360)
  const sky = ctx.createLinearGradient(0, 0, 0, height * 0.6)
  sky.addColorStop(0, 'hsl(' + hue + ', 55%, 70%)')
  sky.addColorStop(1, 'hsl(' + ((hue + 30) % 360) + ', 45%, 88%)')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)
  for (let i = 0; i < 40; i++) {
    const x = random() * width
    const y = height * (0.35 + random() * 0.65)
    const r = width * (0.03 + random() * 0.18)
    const shade = (hue + 90 + random() * 120) % 360
    const fill = ctx.createRadialGradient(x, y, r * 0.1, x, y, r)
    fill.addColorStop(0, 'hsla(' + shade + ', 40%, ' + (25 + random() * 40) + '%, 0.95)')
    fill.addColorStop(1, 'hsla(' + shade + ', 40%, 30%, 0)')
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * (0.5 + random()), random() * 3, 0, Math.PI * 2)
    ctx.fill()
  }
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.floor(random() * (grain * 2 + 1)) - grain
    data[i] += d
    data[i + 1] += d
    data[i + 2] += d
  }
  ctx.putImageData(image, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}`

/** Draws one photo of a kind in a page where PHOTO_SCRIPT has run and returns its JPEG bytes. */
export async function photo(client, kind, seed) {
  const data = await client.evaluate(`(async () => {
    const blob = await window.makePhoto(${seed}, ${JSON.stringify(PHOTO[kind])})
    const url = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(blob)
    })
    return url.slice(url.indexOf(',') + 1)
  })()`)
  return Buffer.from(data, 'base64')
}
