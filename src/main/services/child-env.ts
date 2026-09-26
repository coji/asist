import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'

/**
 * The environment every child process starts with. No child needs a provider's API key: the Python workers
 * and the native helpers run locally, and an agent CLI signs in on its own. An agent job that a prompt
 * injection reaches could otherwise send its environment anywhere, and claude would bill a key found in
 * ANTHROPIC_API_KEY.
 */

/** Variables that no child receives, even when a caller passes one in `extra`. */
export const WITHHELD_VARIABLES: readonly string[] = LLM_PROVIDERS.map((provider) => LLM_PROVIDER_INFO[provider].envKey)

/**
 * A variable's name as the OS compares it. Windows ignores the case, so Anthropic_Api_Key there is the same
 * variable as ANTHROPIC_API_KEY, and a copy of process.env keeps whichever case the name was set in.
 */
export function envNameKey(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name
}

export function childEnv(extra: NodeJS.ProcessEnv = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent }
  for (const [name, value] of Object.entries(extra)) {
    removeVariables(env, (key) => key === envNameKey(name))
    env[name] = value
  }
  const withheld = new Set(WITHHELD_VARIABLES.map(envNameKey))
  removeVariables(env, (key) => withheld.has(key))
  return env
}

/**
 * The environment a Python process starts with. Python on Windows reads and writes its pipes in the
 * locale's code page (cp932, cp1252) and would misread the Japanese in the JSON lines, so UTF-8 mode is
 * turned on, on every OS. Output is unbuffered so that each line reaches the app when it is printed.
 */
export function pythonEnv(extra: NodeJS.ProcessEnv = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnv({ PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', ...extra }, parent)
}

/** Deletes every variable whose name, as the OS compares it, matches. */
export function removeVariables(env: NodeJS.ProcessEnv, matches: (key: string) => boolean): void {
  for (const name of Object.keys(env)) if (matches(envNameKey(name))) delete env[name]
}
