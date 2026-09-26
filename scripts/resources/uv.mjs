import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, stampCurrent, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Fetches the uv that ships inside the app into resources/uv, pinned to one release and verified by
 * sha256. uv builds the Python environments of the local models and downloads the Python they run on.
 */

const VERSION = '0.12.18'
const MODULE = fileURLToPath(import.meta.url)

/** The release asset of each platform and architecture, and the path of the uv binary inside it. */
const ASSETS = {
  'darwin-arm64': {
    name: 'uv-aarch64-apple-darwin.tar.gz',
    sha256: 'cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b',
    binary: 'uv-aarch64-apple-darwin/uv'
  },
  // The zip also carries uvx.exe and uvw.exe, which ASIST never runs.
  'win32-x64': {
    name: 'uv-x86_64-pc-windows-msvc.zip',
    sha256: 'cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff',
    binary: 'uv.exe'
  }
}

export async function prepareUv({ resources, platform, arch }) {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`uv ${VERSION} is not pinned for ${platform} ${arch}`)
  const out = path.join(resources, 'uv')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return

  await withTemporaryDir('asist-uv-', async (work) => {
    const base = 'https://github.com/astral-sh/uv'
    const archive = path.join(work, asset.name)
    console.error(`uv: fetching uv ${VERSION}`)
    await download(`${base}/releases/download/${VERSION}/${asset.name}`, archive, asset.sha256)
    extract(archive, path.join(work, 'unpacked'))
    // The release archive carries no license text, so it comes from the same tag.
    for (const license of ['LICENSE-MIT', 'LICENSE-APACHE']) await download(`${base}/raw/${VERSION}/${license}`, path.join(work, license))
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    const binary = path.join(work, 'unpacked', ...asset.binary.split('/'))
    fs.copyFileSync(binary, path.join(out, path.basename(binary)))
    for (const license of ['LICENSE-MIT', 'LICENSE-APACHE']) fs.copyFileSync(path.join(work, license), path.join(out, license))
    writeStamp(stamp, VERSION, MODULE)
  })
}
