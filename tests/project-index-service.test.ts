import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData }
}))

beforeEach(() => {
  vi.resetModules()
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-projects-'))
})

describe('project index service', () => {
  it('grows from actual use and from an explicit registration, stays in projects.json, and still resolves after a reload', async () => {
    const index = await import('../src/main/services/project-index')
    const repo = path.join(mocks.userData, 'asist')
    fs.mkdirSync(repo)
    index.noteUsed(repo, 100)
    expect(index.resolve('asist')[0].entry).toMatchObject({ name: 'asist', path: repo, source: 'job' })
    const registered = index.register('アシスト', `${repo}/`, 200)
    expect(registered).toMatchObject({ name: 'アシスト', path: repo, aliases: ['asist'], source: 'told' })
    expect(JSON.parse(fs.readFileSync(path.join(mocks.userData, 'projects.json'), 'utf8')).entries).toHaveLength(1)
    index.resetForTest()
    expect(index.resolve('アシスト')[0].entry.path).toBe(repo)
    expect(index.recent().map((e) => e.name)).toEqual(['アシスト'])
  })

  it('registers no relative path, even one naming a folder that exists under the current folder', async () => {
    const index = await import('../src/main/services/project-index')
    expect(() => index.register('x', 'src')).toThrow('[asist:app.storage.folderNotFull')
    expect(() => index.register('x', './tests')).toThrow('[asist:app.storage.folderNotFull')
    expect(index.list()).toEqual([])
  })

  it('registers no directory that does not exist', async () => {
    const index = await import('../src/main/services/project-index')
    expect(() => index.register('x', path.join(mocks.userData, 'nope'))).toThrow('[asist:app.storage.projectDirMissing')
    expect(index.list()).toEqual([])
  })
})
