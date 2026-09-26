/**
 * The environment of the git a test runs itself, in place of the user's or the agent's. Git for Windows sets
 * core.autocrlf=true in its system configuration, so a checkout by that git writes CRLF into a file committed
 * with LF, and ASIST's git, which reads no system configuration, takes the file for an edit.
 */
export function testGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }
}

/**
 * A path written into a command git runs through sh, such as a hook or a filter. The sh of Git for Windows
 * takes a backslash for an escape and drops it, and reads C:/Users/… as the same path as C:\Users\….
 */
export const shellPath = (file: string): string => file.replaceAll('\\', '/')
