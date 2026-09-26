import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { createMailSecretStore } from '../src/main/services/mail-secrets'

/** Mail passwords: only encrypted values ever reach the file, and nothing is stored where encryption is unavailable. */

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-mail-secrets-'))
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

const reverse = (text: string): string => [...text].reverse().join('')
function store(available = true) {
  return createMailSecretStore({
    filePath: path.join(directory, 'nested', 'mail-secrets.json'),
    available: () => available,
    encrypt: (plain) => Buffer.from(reverse(plain), 'utf8'),
    decrypt: (encrypted) => reverse(encrypted.toString('utf8'))
  })
}

describe('createMailSecretStore', () => {
  it('writes each value encrypted, decrypts it on read, and removes it', () => {
    const secrets = store()
    secrets.set('a1', 'app-password-1')
    secrets.set('a2', 'ひみつの合言葉')
    const file = path.join(directory, 'nested', 'mail-secrets.json')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('app-password-1')
    expect(JSON.parse(raw).secrets.a1).toBe(Buffer.from(reverse('app-password-1')).toString('base64'))
    expect(secrets.get('a1')).toBe('app-password-1')
    expect(secrets.get('a2')).toBe('ひみつの合言葉')
    expect(secrets.get('none')).toBeNull()
    secrets.remove('a1')
    expect(secrets.get('a1')).toBeNull()
    expect(store().get('a2')).toBe('ひみつの合言葉')
  })

  // Windows has no POSIX permission bits; a file under the user's profile folder is guarded by that folder's access list.
  it.runIf(process.platform !== 'win32')('writes the file readable by the owner alone', () => {
    store().set('a1', 'app-password-1')
    expect(fs.statSync(path.join(directory, 'nested', 'mail-secrets.json')).mode & 0o777).toBe(0o600)
  })

  it('throws instead of storing or decrypting where encryption is unavailable', () => {
    const secrets = store(false)
    expect(() => secrets.set('a1', 'x')).toThrow(errorText('mail.errors.account.encryptionUnavailable'))
    expect(fs.existsSync(path.join(directory, 'nested', 'mail-secrets.json'))).toBe(false)
    store().set('a1', 'x')
    expect(() => store(false).get('a1')).toThrow(errorText('mail.errors.account.encryptionUnavailable'))
  })

  it('throws on a broken file or an unknown version without overwriting it', () => {
    const file = path.join(directory, 'nested', 'mail-secrets.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ broken')
    expect(() => store().get('a1')).toThrow(/mail.errors.account.fileBroken/)
    fs.writeFileSync(file, JSON.stringify({ version: 9, secrets: {} }))
    expect(() => store().set('a1', 'x')).toThrow(/app.storage.versionTooNew/)
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ version: 9, secrets: {} }))
  })
})
