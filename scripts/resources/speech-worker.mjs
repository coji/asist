import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, stampCurrent, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Puts speech.cpp's speech-worker into resources/speech-worker, pinned to one release and verified by sha256.
 * The local speech synthesis runs in it: Metal on a Mac, Vulkan on Windows. The worker links ggml
 * statically, so it is one file.
 */

const VERSION = 'v0.3.1'
const MODULE = fileURLToPath(import.meta.url)

const ASSETS = {
  'darwin-arm64': {
    name: 'speech-worker-v0.3.1-macos-arm64-metal.zip',
    sha256: 'cefe688c932c5415f3e4b11f89aafcaf7f69f84b254f50b3bd91a3fa9e67ba25',
    worker: 'speech-worker'
  },
  'win32-x64': {
    name: 'speech-worker-v0.3.1-windows-x64-vulkan.zip',
    sha256: 'f416e10b1c011c772f1e9ec108658c0fb0b980b21c6b29221a0d7ee48fcb9868',
    worker: 'speech-worker.exe'
  }
}

export async function prepareSpeechWorker({ resources, platform, arch }) {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`speech.cpp ${VERSION} is not pinned for ${platform} ${arch}`)
  const out = path.join(resources, 'speech-worker')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return

  await withTemporaryDir('asist-speech-worker-', async (work) => {
    const base = 'https://github.com/nyosegawa/speech.cpp'
    const archive = path.join(work, asset.name)
    console.error(`speech.cpp: fetching ${VERSION}`)
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
