import { describe, expect, it } from 'vitest'
import { shortPath } from '../src/renderer/src/ui/JobLog'

describe('shortPath', () => {
  it('keeps the last two names of a long path, shown with the separator of its form', () => {
    expect(shortPath('/Users/me/repo/src/app.ts')).toBe('…/src/app.ts')
    expect(shortPath('C:\\Users\\me\\repo\\src\\app.ts')).toBe('…\\src\\app.ts')
    expect(shortPath('C:/Users/me/repo/src/app.ts')).toBe('…\\src\\app.ts')
    expect(shortPath('//nas/team/repo/src/app.ts')).toBe('…\\src\\app.ts')
  })

  it('shortens a POSIX path by its "/" alone, keeping a "\\" inside a name', () => {
    expect(shortPath('/Users/me/repo/a\\b.txt')).toBe('…/repo/a\\b.txt')
    expect(shortPath('/a//b/c/d')).toBe('…/c/d')
    expect(shortPath('/a/b/c/')).toBe('…/b/c')
  })

  it('leaves a path of two names or fewer whole', () => {
    for (const p of ['/Users/me', 'C:\\Users\\me', 'src/app.ts', 'app.ts', '/']) expect(shortPath(p)).toBe(p)
  })
})
