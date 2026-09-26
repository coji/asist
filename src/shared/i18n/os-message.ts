import type { OsFamily } from '../platform'
import type { MessageKey } from '.'

/**
 * The OS families a message that names a part of the OS is written for. A message such as "Show in
 * Finder" is kept once per OS under `<key>.macos` and `<key>.windows`; every other message names no OS.
 */
export const OS_MESSAGE_VARIANTS = { macos: true, windows: true } as const satisfies Record<OsFamily, true>

/** The key of a message written once per OS: the part before `.macos`, when every OS has its message. */
export type OsMessageKey = {
  [K in MessageKey]: K extends `${infer Base}.macos` ? ([`${Base}.${OsFamily}`] extends [MessageKey] ? Base : never) : never
}[MessageKey]

/**
 * The message for this OS: `t(osMessageKey('files.reveal', capabilities.os))`. The renderer passes the
 * `os` of the platform capabilities, and the main process the one of its own platformCapabilities().
 */
export const osMessageKey = <K extends OsMessageKey>(key: K, os: OsFamily): Extract<`${K}.${OsFamily}`, MessageKey> =>
  `${key}.${os}` as Extract<`${K}.${OsFamily}`, MessageKey>
