import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, upToDate, withTemporaryDir } from './shared.mjs'

/**
 * Builds resources/native/windows/asist-agent-launcher.exe, which starts an agent CLI inside a job object,
 * with the MSVC compiler of the Visual Studio that vswhere finds. A launcher older than its source or than
 * this module is built again.
 */

export async function prepareNativeWindows({ resources }) {
  const dir = path.join(resources, 'native', 'windows')
  const source = path.join(dir, 'asist-agent-launcher.c')
  const out = path.join(dir, 'asist-agent-launcher.exe')
  if (upToDate(out, [source, fileURLToPath(import.meta.url)])) return

  const env = msvcEnvironment()
  console.error('native: compiling asist-agent-launcher.exe')
  await withTemporaryDir('asist-launcher-', async (work) => {
    // /MT links the C runtime statically, so the launcher needs no Visual C++ redistributable. The object
    // file goes to the temporary folder, the working directory of cl.exe.
    run(findOnPath('cl.exe', env), ['/nologo', '/W4', '/WX', '/O2', '/MT', '/utf-8', `/Fe${out}`, source], { env, cwd: work })
  })
}

/** The environment vcvars64.bat sets up for the x64 compiler, read back from cmd.exe. */
function msvcEnvironment() {
  const programFiles = process.env['ProgramFiles(x86)']
  if (!programFiles) throw new Error('ProgramFiles(x86) is not set, so vswhere cannot be found')
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!fs.existsSync(vswhere)) throw new Error(`${vswhere} not found; install Visual Studio with the C++ build tools`)
  const vcvars = execFileSync(
    vswhere,
    ['-latest', '-utf8', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'VC\\Auxiliary\\Build\\vcvars64.bat'],
    { encoding: 'utf8', windowsHide: true }
  )
    .split(/\r?\n/)
    .find(Boolean)
  if (!vcvars) throw new Error('vswhere found no Visual Studio with the x64 C++ compiler; install the C++ build tools')
  // cmd.exe with /s drops the outer quotes and keeps the ones around the path, which has spaces in it.
  // Into a pipe, set writes in the OEM code page (cp932 on Japanese Windows), which garbles a user name in
  // TMP and TEMP; /u makes it write UTF-16LE.
  const output = execFileSync('cmd.exe', ['/d', '/u', '/s', '/c', `""${vcvars}" >nul && set"`], {
    encoding: 'utf16le',
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  const env = {}
  for (const line of output.split(/\r?\n/)) {
    const equals = line.indexOf('=')
    if (equals > 0) env[line.slice(0, equals)] = line.slice(equals + 1)
  }
  return env
}

function findOnPath(name, env) {
  const key = Object.keys(env).find((variable) => variable.toUpperCase() === 'PATH')
  const found = (key ? env[key].split(';') : []).map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file))
  if (!found) throw new Error(`${name} is not on the PATH that vcvars64.bat set up`)
  return found
}
