import { describe, expect, it } from 'vitest'
import { CLAUDE_READONLY_TOOLS, buildResumeArgs, buildStartArgs, displayCommand } from '@shared/agent-cli'
import { errorText } from '@shared/i18n/error-text'

const codex = { engine: 'codex' as const, os: 'macos' as const, prompt: '調べて', cwd: '/repo', readonly: true, sessionId: 'thread-1' }
const claude = { engine: 'claude' as const, os: 'macos' as const, prompt: '調べて', cwd: '/repo', readonly: false, sessionId: 'sess-1' }
const curation = { memoryCuration: { through: '2026-09-22', applied: false }, readonly: false, cwd: '/memory/wt' }

describe('buildStartArgs', () => {
  it('passes the cwd and the sandbox to codex exec --json, read-only for a read-only job', () => {
    expect(buildStartArgs(codex)).toEqual([
      'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', '/repo', '-s', 'read-only', '-'
    ])
    expect(buildStartArgs({ ...codex, readonly: false })).toEqual([
      'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', '/repo', '--approve-for-me', '-'
    ])
  })

  it('runs claude with stream-json, auto permissions when it may write, and plan mode with read-only tools otherwise', () => {
    expect(buildStartArgs(claude)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'])
    const readonly = buildStartArgs({ ...claude, readonly: true })
    expect(readonly).toContain('plan')
    expect(readonly).toContain(CLAUDE_READONLY_TOOLS)
    expect(CLAUDE_READONLY_TOOLS).not.toMatch(/Bash|Write|Edit/)
  })
})

describe('buildResumeArgs', () => {
  it('resumes codex with exec resume <thread_id> -, reading the prompt from stdin, and passes the sandbox through -c', () => {
    expect(buildResumeArgs(codex)).toEqual([
      'exec', 'resume', '--json', '--ignore-user-config', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'thread-1', '-'
    ])
  })

  it('resumes a writing codex job with the settings behind --approve-for-me, which resume does not take', () => {
    const args = buildResumeArgs({ ...codex, readonly: false })
    expect(args).not.toContain('--approve-for-me')
    expect(args.filter((arg) => arg.includes('='))).toEqual(['sandbox_mode="workspace-write"', 'approval_policy="on-request"', 'approvals_reviewer="auto_review"'])
    expect(args.slice(-2)).toEqual(['thread-1', '-'])
  })

  it('resumes claude with --resume <session_id> and keeps the same permissions', () => {
    const args = buildResumeArgs({ ...claude, readonly: true })
    expect(args.slice(0, 3)).toEqual(['-p', '--resume', 'sess-1'])
    expect(args).toContain('plan')
  })

  it('throws when the job has no session ID', () => {
    expect(() => buildResumeArgs({ ...codex, sessionId: undefined })).toThrow(errorText('jobs.continue.noSession'))
  })
})

describe('a memory curation job, which starts with nobody to confirm it', () => {
  it('never runs claude in auto mode: restricted, refusing what is not allowed, with the skill\'s two checks as the only commands', () => {
    for (const args of [buildStartArgs({ ...claude, ...curation }), buildResumeArgs({ ...claude, ...curation })]) {
      expect(args).not.toContain('auto')
      expect(args).toContain('--restricted')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
      expect(allowed.filter((rule) => rule.startsWith('Bash'))).toEqual([
        'Bash(uv run --no-project .claude/skills/memory-curation/scripts/count.py *)',
        'Bash(uv run --no-project /memory/wt/.claude/skills/memory-curation/scripts/count.py *)',
        'Bash(uv run --no-project .claude/skills/memory-curation/scripts/validate.py *)',
        'Bash(uv run --no-project /memory/wt/.claude/skills/memory-curation/scripts/validate.py *)'
      ])
      expect(allowed).not.toContain('WebFetch')
      expect(args.slice(args.indexOf('--disallowedTools') + 1)).toContain('Edit(./.claude/skills/**)')
    }
  })

  it('runs codex in the workspace-write sandbox with no approvals, never through the automatic review', () => {
    for (const args of [buildStartArgs({ ...codex, ...curation }), buildResumeArgs({ ...codex, ...curation })]) {
      expect(args).not.toContain('--approve-for-me')
      expect(args.filter((arg) => arg.includes('='))).toEqual(['sandbox_mode="workspace-write"', 'approval_policy="never"'])
    }
  })
})

describe('the OS a codex job runs on', () => {
  const kinds = { readonly: {}, writing: { readonly: false }, curation } as const
  const build = { start: buildStartArgs, resume: buildResumeArgs } as const
  const SANDBOX = ['-c', 'windows.sandbox="elevated"']

  it('keeps the macOS arguments of every kind of job, started and resumed', () => {
    const start = ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C']
    const resume = ['exec', 'resume', '--json', '--ignore-user-config', '--skip-git-repo-check']
    expect(buildStartArgs(codex)).toEqual([...start, '/repo', '-s', 'read-only', '-'])
    expect(buildStartArgs({ ...codex, readonly: false })).toEqual([...start, '/repo', '--approve-for-me', '-'])
    expect(buildStartArgs({ ...codex, ...curation })).toEqual([
      ...start, '/memory/wt', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '-'
    ])
    expect(buildResumeArgs(codex)).toEqual([...resume, '-c', 'sandbox_mode="read-only"', 'thread-1', '-'])
    expect(buildResumeArgs({ ...codex, readonly: false })).toEqual([
      ...resume, '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"', 'thread-1', '-'
    ])
    expect(buildResumeArgs({ ...codex, ...curation })).toEqual([
      ...resume, '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', 'thread-1', '-'
    ])
  })

  it.each(Object.keys(kinds) as Array<keyof typeof kinds>)('runs a %s codex job on Windows in the elevated sandbox, started and resumed, and otherwise as on macOS', (kind) => {
    for (const make of Object.values(build)) {
      const job = { ...codex, ...kinds[kind] }
      const windows = make({ ...job, os: 'windows' })
      const at = windows.findIndex((arg, i) => arg === SANDBOX[0] && windows[i + 1] === SANDBOX[1])
      expect(at).toBeGreaterThan(-1)
      expect(windows.toSpliced(at, 2)).toEqual(make(job))
      expect(make(job)).not.toContain(SANDBOX[1])
    }
  })

  it('gives claude the same arguments on Windows as on macOS', () => {
    for (const job of [claude, { ...claude, readonly: true }, { ...claude, ...curation }]) {
      expect(buildStartArgs({ ...job, os: 'windows' })).toEqual(buildStartArgs(job))
      expect(buildResumeArgs({ ...job, os: 'windows' })).toEqual(buildResumeArgs(job))
    }
  })
})

describe('displayCommand', () => {
  it('shows a different command for start and for resume, and truncates a long prompt', () => {
    expect(displayCommand(codex)).toBe('$ codex exec -s read-only "調べて"')
    expect(displayCommand({ ...codex, readonly: false })).toBe('$ codex exec --approve-for-me "調べて"')
    expect(displayCommand(claude, '続き')).toBe('$ claude -p --resume sess-1 "続き"')
    expect(displayCommand({ ...claude, prompt: 'あ'.repeat(100) })).toContain('…')
  })
})
