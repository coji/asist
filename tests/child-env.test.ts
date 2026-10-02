import { afterEach, describe, expect, it } from 'vitest'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import { childEnv, pythonEnv } from '../src/main/services/child-env'

/** No child process may receive a provider's API key, whether it came from the parent environment or a caller. */

const providerKeys = LLM_PROVIDERS.map((provider) => LLM_PROVIDER_INFO[provider].envKey)

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
})
const simulate = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

describe('childEnv', () => {
  it('drops every provider key and keeps the rest of the environment and the extra variables', () => {
    const parent = {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: '/Users/someone',
      LANG: 'ja_JP.UTF-8',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
      ...Object.fromEntries(providerKeys.map((name) => [name, `secret-${name}`]))
    }
    const env = childEnv({ PYTHONUNBUFFERED: '1', OPENAI_API_KEY: 'passed-by-a-caller' }, parent)
    for (const name of providerKeys) expect(env).not.toHaveProperty(name)
    expect(env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: '/Users/someone',
      LANG: 'ja_JP.UTF-8',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
      PYTHONUNBUFFERED: '1'
    })
    expect(parent.ANTHROPIC_API_KEY).toBe('secret-ANTHROPIC_API_KEY')
  })

  it('drops a provider key written in any case on Windows, where the case of a name does not matter', () => {
    simulate('win32')
    const env = childEnv({ openai_api_key: 'passed-by-a-caller' }, { Path: 'C:\\Windows', Anthropic_Api_Key: 'secret' })
    expect(env).toEqual({ Path: 'C:\\Windows' })
  })

  it('lets a variable passed by a caller replace the inherited one written in another case on Windows', () => {
    simulate('win32')
    expect(childEnv({ PATH: 'C:\\tools' }, { Path: 'C:\\Windows', HOMEDRIVE: 'C:' })).toEqual({ PATH: 'C:\\tools', HOMEDRIVE: 'C:' })
  })

  it('keeps names that differ only in case apart on macOS, where they are different variables', () => {
    simulate('darwin')
    expect(childEnv({ path: '/extra' }, { PATH: '/usr/bin', Anthropic_Api_Key: 'not-the-key' })).toEqual({
      PATH: '/usr/bin',
      Anthropic_Api_Key: 'not-the-key',
      path: '/extra'
    })
  })
})

describe('pythonEnv', () => {
  it('starts Python in UTF-8 mode and unbuffered, and still withholds every provider key', () => {
    simulate('win32')
    const env = pythonEnv({ HF_HUB_OFFLINE: '1' }, { Path: 'C:\\Windows', PYTHONUTF8: '0', Anthropic_Api_Key: 'secret' })
    expect(env).toEqual({ Path: 'C:\\Windows', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' })
  })

  it.each(['darwin', 'win32'] as const)('leaves out the Python settings of the user\'s own Python, which would change what the worker imports (%s)', (platform) => {
    simulate(platform)
    const env = pythonEnv({}, {
      PATH: '/usr/bin',
      PYTHONPATH: '/opt/other-python/lib/python3.9/site-packages',
      PythonHome: '/opt/other-python',
      PYTHONIOENCODING: 'cp932',
      PYTHONINSPECT: '1'
    })
    // macOS keeps a name written in another case apart, and Python there reads only the upper-case one.
    expect(env).toEqual({ PATH: '/usr/bin', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', ...(platform === 'darwin' ? { PythonHome: '/opt/other-python' } : {}) })
  })
})
