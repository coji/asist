import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/user-git-settings.ts', 'tests/setup/host-platform.ts'],
    // What a passing test logs, such as a warning it provokes on purpose, filled more than a thousand lines of
    // CI's log around the results. A failing test still shows everything it logged.
    silent: 'passed-only',
    // A git call takes about twice as long on Windows as on macOS (23 ms against 13 ms for rev-parse), and the
    // git tests of a job's worktree that take 2 to 4 s alone on Windows took up to 8 s beside the other test
    // files, past the default of 5 s (Windows 11 x64 and Apple M5, 2026-09-27). Their hooks make the
    // repositories with the same git calls, and one that adds a submodule took over 10 s, the default for a
    // hook, on a windows-latest runner of GitHub Actions (2026-10-01).
    ...(process.platform === 'win32' ? { testTimeout: 20_000, hookTimeout: 20_000 } : {})
  }
})
