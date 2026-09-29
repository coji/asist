import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, stampCurrent, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Puts qwen3-tts-ggml's worker into resources/qwen3-tts, pinned to one release and verified by sha256. The
 * local speech synthesis runs Qwen3-TTS in it: Metal on a Mac, Vulkan on Windows. The worker links ggml
 * statically, so it is one file.
 */

const VERSION = 'v0.1.1'
const MODULE = fileURLToPath(import.meta.url)

const ASSETS = {
  'darwin-arm64': {
    name: 'qwen3-tts-ggml-v0.1.1-macos-arm64-metal.zip',
    sha256: '2a1703b5b6b0125ebcddd37cbeffcad3384bc8c386e0e57bf838029687053d81',
    worker: 'qwen3-tts-worker'
  },
  'win32-x64': {
    name: 'qwen3-tts-ggml-v0.1.1-windows-x64-vulkan.zip',
    sha256: 'c33a4a62572b99159ee7faf1b5b56b4f1d5268e7b0512987bd6605c1001a3724',
    worker: 'qwen3-tts-worker.exe'
  }
}

export async function prepareQwen3Tts({ resources, platform, arch }) {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`qwen3-tts-ggml ${VERSION} is not pinned for ${platform} ${arch}`)
  const out = path.join(resources, 'qwen3-tts')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return

  await withTemporaryDir('asist-qwen3-tts-', async (work) => {
    const base = 'https://github.com/nyosegawa/qwen3-tts-ggml'
    const archive = path.join(work, asset.name)
    console.error(`qwen3-tts-ggml: fetching ${VERSION}`)
    await download(`${base}/releases/download/${VERSION}/${asset.name}`, archive, asset.sha256)
    extract(archive, path.join(work, 'unpacked'))
    await download(`${base}/raw/${VERSION}/LICENSE`, path.join(work, 'LICENSE'))
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    fs.copyFileSync(path.join(work, 'unpacked', asset.worker), path.join(out, asset.worker))
    fs.chmodSync(path.join(out, asset.worker), 0o755)
    fs.copyFileSync(path.join(work, 'LICENSE'), path.join(out, 'LICENSE'))
    writeStamp(stamp, VERSION, MODULE)
  })
}
