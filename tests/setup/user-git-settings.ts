import { vi } from 'vitest'

/**
 * ASIST's git takes over the working-tree settings of the git installed on the machine, and Git for Windows
 * sets core.autocrlf=true in its system configuration, which would check a job's files out with CRLF. Every
 * test file therefore starts from a user whose git sets none of them, and a test that needs some mocks the
 * module again.
 */
vi.mock('../../src/main/services/git-user-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/services/git-user-settings')>()),
  userGitSettings: () => new Map()
}))
