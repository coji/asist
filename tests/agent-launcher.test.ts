import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The launcher is a Windows program, built by scripts/prepare-resources.mjs; these tests run it for real.
const launcher = path.resolve('resources/native/windows/asist-agent-launcher.exe')
const EXIT_STOPPED = 130

const started: ChildProcess[] = []

// Killing a launcher closes the last handle of its job, which ends whatever a failed test left in it. The
// pids a test read are never killed here: Windows gives a freed pid to a new process at once.
afterEach(() => {
  for (const child of started.splice(0)) child.kill()
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function launch(token: string, parentPid: number, program: string, args: string[]): ChildProcess {
  const child = spawn(launcher, ['--run', token, String(parentPid), program, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  started.push(child)
  return child
}

const exited = (child: ChildProcess): Promise<number | null> => new Promise((resolve) => child.once('exit', (code) => resolve(code)))

const output = (child: ChildProcess): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    child.stdout!.on('data', (data) => (text += String(data)))
    child.once('close', () => resolve(text))
  })

/** The first line the program writes, which the programs below use to report the pids they started. */
const firstLine = (child: ChildProcess): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = ''
    child.stdout!.on('data', (data) => {
      text += String(data)
      if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n')))
    })
    child.once('exit', (code) => reject(new Error(`exited with ${code} before a line: ${text}`)))
  })

const tool = (args: string[]): { status: number | null; stdout: string } => {
  const result = spawnSync(launcher, args, { encoding: 'utf8', windowsHide: true })
  return { status: result.status, stdout: result.stdout.trim() }
}

/**
 * A program that starts a grandchild, reports both pids, and keeps running or exits. A detached grandchild
 * leaves the program's lifetime; one that is not goes into the job libuv gives the program's children.
 */
const leavesDescendant = (keepRunning: boolean, detached = true): string => `
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: ${detached}, stdio: 'ignore' });
  grandchild.unref();
  process.stdout.write(process.pid + ' ' + grandchild.pid + '\\n');
  ${keepRunning ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 200);'}
`

describe.runIf(process.platform === 'win32')('the Windows agent launcher', { timeout: 20_000 }, () => {
  it('starts the program only after "start", with its arguments unchanged and the rest of the input, and exits with its code', async () => {
    const args = ['plain', 'with space', 'say "hi"', 'Bash(node C:\\tools\\validate.mjs *)', 'trailing\\', '', '-c', 'sandbox_mode="workspace-write"']
    const program = `
      let input = '';
      process.stdin.on('data', (d) => (input += d));
      process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ args: process.argv.slice(1), input })); process.exit(7) });
    `
    const child = launch(randomUUID(), process.pid, process.execPath, ['-e', program, '--', ...args])
    const text = output(child)
    child.stdin!.end('start\nthe prompt, with\nlines\n')
    expect(await exited(child)).toBe(7)
    expect(JSON.parse(await text)).toEqual({ args, input: 'the prompt, with\nlines\n' })
  })

  it('never starts the program when the input ends before "start"', async () => {
    const marker = path.join(os.tmpdir(), `asist-launcher-${randomUUID()}`)
    const child = launch(randomUUID(), process.pid, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`])
    child.stdin!.end()
    expect(await exited(child)).toBe(EXIT_STOPPED)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it.each([true, false])('exits only once a descendant the program left behind is gone (detached: %s)', async (detached) => {
    const child = launch(randomUUID(), process.pid, process.execPath, ['-e', leavesDescendant(false, detached)])
    const pids = firstLine(child)
    child.stdin!.end('start\n')
    const [, grandchild] = (await pids).split(' ').map(Number)
    expect(await exited(child)).toBe(0)
    expect(alive(grandchild)).toBe(false)
  })

  it('stops the program and its descendants when the parent ends first', async () => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    started.push(parent)
    const child = launch(randomUUID(), parent.pid!, process.execPath, ['-e', leavesDescendant(true)])
    const pids = firstLine(child)
    child.stdin!.end('start\n')
    const [program, grandchild] = (await pids).split(' ').map(Number)
    parent.kill()
    expect(await exited(child)).toBe(EXIT_STOPPED)
    expect(alive(program)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })

  it('reports and stops the job of a token, and reports it gone afterwards', async () => {
    const token = randomUUID()
    const child = launch(token, process.pid, process.execPath, ['-e', leavesDescendant(true)])
    const pids = firstLine(child)
    child.stdin!.end('start\n')
    const [program, grandchild] = (await pids).split(' ').map(Number)
    expect(Number(tool(['--inspect', token]).stdout)).toBe(2)
    expect(tool(['--stop', token])).toEqual({ status: 0, stdout: 'stopped' })
    expect(await exited(child)).toBe(EXIT_STOPPED)
    expect(alive(grandchild)).toBe(false)
    expect(tool(['--inspect', token])).toEqual({ status: 0, stdout: 'gone' })
    expect(tool(['--stop', randomUUID()])).toEqual({ status: 0, stdout: 'gone' })
  })

  it('never starts the program when a stop comes after the job exists but before "start"', async () => {
    const token = randomUUID()
    const marker = path.join(os.tmpdir(), `asist-launcher-${randomUUID()}`)
    const child = launch(token, process.pid, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`])
    while (tool(['--inspect', token]).stdout === 'gone') await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tool(['--stop', token])).toEqual({ status: 0, stdout: 'stopped' })
    child.stdin!.end('start\n')
    expect(await exited(child)).toBe(EXIT_STOPPED)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('refuses a program that is not an .exe, and a token that is not one', () => {
    const script = path.join(os.tmpdir(), 'asist-launcher-refused.cmd')
    expect(tool(['--run', randomUUID(), String(process.pid), script]).status).toBe(1)
    expect(tool(['--inspect', '..\\..\\BaseNamedObjects\\x']).status).toBe(1)
  })
})
