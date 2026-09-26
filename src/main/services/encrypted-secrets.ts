import fs from 'node:fs'
import path from 'node:path'
import { storedContent, type StoredFormat } from '@shared/stored-format'
import { writeJsonFileAtomicSync } from './atomic-json'
import { openStoredFileSync } from './stored-file'

/**
 * A JSON file of secrets by id, each encrypted with the OS key that Electron's safeStorage uses, which on
 * macOS is a Keychain key. A development run and the installed build get different keys, so a secret
 * entered in one cannot be read by the other. Where encryption is unavailable this fails instead of
 * storing the secret in plain text.
 */

/** The form of a secrets file. `broken` is the message for content that is not a map of strings. */
export function secretFileFormat(name: string, broken: () => string): StoredFormat<SecretFile> {
  return {
    name,
    version: 1,
    upgrades: {},
    parse: (content) => {
      const secrets = (content as Partial<SecretFile> | null)?.secrets
      if (!secrets || typeof secrets !== 'object' || Object.values(secrets).some((value) => typeof value !== 'string')) {
        throw new Error(broken())
      }
      return { secrets: { ...secrets } }
    },
    serialize: (file) => ({ secrets: file.secrets })
  }
}

export interface SecretFile {
  /** Maps an id to the encrypted secret, base64 encoded. */
  secrets: Record<string, string>
}

/** safeStorage in the app; tests hand in a reversible stand-in. */
export interface SecretEncryption {
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (encrypted: Buffer) => string
}

/** The error message of each failure, worded for the kind of secret the file holds. */
export interface SecretStoreErrors<Id extends string = string> {
  encryptionUnavailable: () => string
  secretUnreadable: (id: Id) => string
  fileUnreadable: (file: string, reason: string) => string
  fileBroken: (file: string) => string
}

export interface EncryptedSecretStoreOptions<Id extends string = string> extends SecretEncryption {
  filePath: string
  errors: SecretStoreErrors<Id>
}

/** A stored secret this process cannot decrypt, because another build or another Keychain encrypted it. */
export class SecretUnreadableError extends Error {}

export interface EncryptedSecretStore<Id extends string = string> {
  /** Returns null when no secret is stored, and throws SecretUnreadableError when a stored secret cannot be decrypted. */
  get(id: Id): string | null
  set(id: Id, secret: string): void
  remove(id: Id): void
}

export function createEncryptedSecretStore<Id extends string = string>(options: EncryptedSecretStoreOptions<Id>): EncryptedSecretStore<Id> {
  const { filePath, errors } = options
  let cache: SecretFile | null = null
  const format = secretFileFormat(path.basename(filePath), () => errors.fileBroken(filePath))

  const load = (): SecretFile => {
    if (cache) return cache
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cache = { secrets: {} })
      throw new Error(errors.fileUnreadable(filePath, String(error)), { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(errors.fileBroken(filePath), { cause: error })
    }
    return (cache = openStoredFileSync(filePath, parsed, format))
  }

  const save = (next: SecretFile): void => {
    writeJsonFileAtomicSync(filePath, storedContent(format, next))
    cache = next
  }

  const requireEncryption = (): void => {
    if (!options.available()) throw new Error(errors.encryptionUnavailable())
  }

  return {
    get: (id) => {
      const encoded = load().secrets[id]
      if (encoded === undefined) return null
      requireEncryption()
      try {
        return options.decrypt(Buffer.from(encoded, 'base64'))
      } catch (error) {
        throw new SecretUnreadableError(errors.secretUnreadable(id), { cause: error })
      }
    },
    set: (id, secret) => {
      requireEncryption()
      const current = load()
      save({ secrets: { ...current.secrets, [id]: options.encrypt(secret).toString('base64') } })
    },
    remove: (id) => {
      const current = load()
      if (!(id in current.secrets)) return
      const secrets = { ...current.secrets }
      delete secrets[id]
      save({ secrets })
    }
  }
}
