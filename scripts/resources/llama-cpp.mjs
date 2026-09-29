import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, stampCurrent, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Puts llama.cpp's llama-server into resources/llama.cpp, pinned to one release and verified by sha256. The
 * local speech recognition runs Qwen3-ASR on it: Metal on a Mac, Vulkan on Windows.
 */

const VERSION = 'b11246'
const MODULE = fileURLToPath(import.meta.url)

/**
 * The release asset of each platform and architecture, and the files of it llama-server loads. The macOS
 * build links its libraries by their .0 names through @loader_path, and the archive has those names only
 * as symbolic links; the real files are copied under the names that are loaded. On Windows ggml picks the
 * CPU library that suits the processor at run time, so every variant stays.
 */
const ASSETS = {
  'darwin-arm64': {
    name: 'llama-b11246-bin-macos-arm64.tar.gz',
    sha256: 'b463a0a8b0572e25b5b97647202b7a898a29120bcf3f19aa5a8db4b997f16708',
    folder: 'llama-b11246',
    files: [
      'llama-server',
      'libllama-server-impl.dylib',
      'libllama.0.dylib',
      'libllama-common.0.dylib',
      'libmtmd.0.dylib',
      'libggml.0.dylib',
      'libggml-base.0.dylib',
      'libggml-cpu.0.dylib',
      'libggml-blas.0.dylib',
      'libggml-metal.0.dylib',
      'libggml-rpc.0.dylib',
      'LICENSE'
    ]
  },
  'win32-x64': {
    name: 'llama-b11246-bin-win-vulkan-x64.zip',
    sha256: 'a6195668eeaadfa80e9c2ec27875e35125a1b44e94d17e72c8725b7725e5ccd3',
    folder: '.',
    files: [
      'llama-server.exe',
      'llama-server-impl.dll',
      'llama.dll',
      'llama-common.dll',
      'mtmd.dll',
      'ggml.dll',
      'ggml-base.dll',
      'ggml-vulkan.dll',
      /^ggml-cpu-[a-z0-9]+\.dll$/,
      'libomp.dll',
      'LICENSE-LLVM-OpenMP'
    ]
  }
}

export async function prepareLlamaCpp({ resources, platform, arch }) {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`llama.cpp ${VERSION} is not pinned for ${platform} ${arch}`)
  const out = path.join(resources, 'llama.cpp')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return

  await withTemporaryDir('asist-llama-cpp-', async (work) => {
    const base = 'https://github.com/ggml-org/llama.cpp'
    const archive = path.join(work, asset.name)
    console.error(`llama.cpp: fetching ${VERSION}`)
    await download(`${base}/releases/download/${VERSION}/${asset.name}`, archive, asset.sha256)
    extract(archive, path.join(work, 'unpacked'))
    const from = path.join(work, 'unpacked', asset.folder)
    // The Windows archive carries no license of llama.cpp itself, so it comes from the same tag.
    if (!fs.existsSync(path.join(from, 'LICENSE'))) await download(`${base}/raw/${VERSION}/LICENSE`, path.join(from, 'LICENSE'))
    const names = fs.readdirSync(from)
    const chosen = asset.files.flatMap((entry) => {
      const matched = typeof entry === 'string' ? names.filter((name) => name === entry) : names.filter((name) => entry.test(name))
      if (matched.length === 0) throw new Error(`llama.cpp ${VERSION} has no ${entry} in ${asset.name}`)
      return matched
    })
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    for (const name of [...chosen, ...(chosen.includes('LICENSE') ? [] : ['LICENSE'])]) {
      // realpath follows the archive's links to the versioned library they name.
      fs.copyFileSync(fs.realpathSync(path.join(from, name)), path.join(out, name))
      if (!name.startsWith('LICENSE')) fs.chmodSync(path.join(out, name), 0o755)
    }
    writeStamp(stamp, VERSION, MODULE)
  })
}
