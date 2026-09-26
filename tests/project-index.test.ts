import { describe, expect, it } from 'vitest'
import { matchProjects, recentProjects, upsertProject, type ProjectEntry } from '@shared/project-index'

const entry = (name: string, path: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  name,
  path,
  aliases: [],
  lastUsedAt: 0,
  source: 'job',
  ...extra
})

const entries = [
  entry('asist', '/Users/me/src/github.com/example/asist', { aliases: ['アシスト'], lastUsedAt: 10 }),
  entry('voice-notes', '/Users/me/src/github.com/example/voice-notes', { lastUsedAt: 20 }),
  entry('lp', '/Users/me/work/lp-site', { aliases: ['例のLP'], lastUsedAt: 5 })
]

describe('matchProjects', () => {
  it('ranks an exact match of the name, of an alias or of the directory name highest', () => {
    expect(matchProjects(entries, 'asist')[0]).toMatchObject({ score: 1, entry: { name: 'asist' } })
    expect(matchProjects(entries, 'アシスト')[0].entry.name).toBe('asist')
    expect(matchProjects(entries, 'lp-site')[0].entry.name).toBe('lp')
    expect(matchProjects(entries, 'ＡＳＩＳＴ')[0].entry.name).toBe('asist')
  })

  it('still matches a garbled name through a substring and the bigram ratio', () => {
    expect(matchProjects(entries, 'voice')[0].entry.name).toBe('voice-notes')
    expect(matchProjects(entries, '例のLPのやつ')[0].entry.name).toBe('lp')
  })

  it('returns nothing that does not match, and orders a tie by the most recently used', () => {
    expect(matchProjects(entries, '宇宙')).toEqual([])
    const tied = [entry('a', '/x/repo-one', { lastUsedAt: 1 }), entry('a', '/y/repo-two', { lastUsedAt: 9 })]
    expect(matchProjects(tied, 'a').map((c) => c.entry.path)).toEqual(['/y/repo-two', '/x/repo-one'])
  })
})

describe('upsertProject', () => {
  it('adds a new path, and merges the name and the aliases of an existing one while advancing its timestamp', () => {
    let list = upsertProject([], { path: '/repo/asist/', source: 'job', now: 1 })
    expect(list).toEqual([{ name: 'asist', path: '/repo/asist', aliases: [], lastUsedAt: 1, source: 'job' }])
    list = upsertProject(list, { path: '/repo/asist', name: 'アシスト', source: 'told', now: 5 })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'アシスト', aliases: ['asist'], lastUsedAt: 5, source: 'told' })
    list = upsertProject(list, { path: '/repo/asist', alias: '例のやつ', source: 'job', now: 3 })
    expect(list[0]).toMatchObject({ name: 'アシスト', aliases: ['asist', '例のやつ'], lastUsedAt: 5, source: 'told' })
  })

  it('keeps one entry for a Windows folder that git writes with "/" and the user with "\\" in another letter case', () => {
    let list = upsertProject([], { path: 'C:/Users/me/src/asist', source: 'job', now: 1 })
    expect(list).toEqual([{ name: 'asist', path: 'C:/Users/me/src/asist', aliases: [], lastUsedAt: 1, source: 'job' }])
    list = upsertProject(list, { path: 'c:\\users\\me\\src\\asist\\', name: 'アシスト', source: 'told', now: 2 })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'アシスト', aliases: ['asist'], lastUsedAt: 2 })
    expect(upsertProject(list, { path: 'C:\\Users\\me\\src\\asist-old', source: 'job', now: 3 })).toHaveLength(2)
  })

  it('takes the directory name of a Windows path as the name', () => {
    expect(upsertProject([], { path: 'C:\\Users\\me\\lp-site\\', source: 'job', now: 1 })[0]).toMatchObject({ name: 'lp-site', path: 'C:\\Users\\me\\lp-site' })
    expect(matchProjects([entry('x', 'D:\\work\\voice-notes')], 'voice-notes')[0].score).toBe(1)
  })
})

describe('recentProjects', () => {
  it('returns the most recently used projects up to the limit', () => {
    expect(recentProjects(entries, 2).map((e) => e.name)).toEqual(['voice-notes', 'asist'])
  })
})
