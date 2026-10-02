import type { MessageStructureObject } from 'imapflow'
import { htmlToText } from 'html-to-text'
import type { MailAttachment } from '@shared/mail'
import type { MailBodyParts } from './mail-cache'
import { readBytes, type ImapClient } from './mail-imap'

/**
 * The body of a message as text: which parts of its structure hold it, how they are downloaded, and how the
 * bytes of an HTML part become text.
 */

/** The byte limit of a body download. A longer body is stored truncated at this point. */
export const MAX_BODY_BYTES = 512 * 1024

/**
 * Picks, from the bodyStructure, the part numbers of the text/plain and text/html parts to use as the
 * body, along with the attachments. A part counts as an attachment when its disposition is attachment,
 * or when it has a filename and is not a text part. A single-part message has no part number, so '1' is
 * used, which imapflow resolves to TEXT.
 */
export function bodyPartsOf(structure: MessageStructureObject | undefined): { parts: MailBodyParts; attachments: MailAttachment[] } {
  const parts: MailBodyParts = { textPart: null, htmlPart: null }
  const attachments: MailAttachment[] = []
  const walk = (node: MessageStructureObject): void => {
    const type = node.type.toLowerCase()
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes ?? []) walk(child)
      return
    }
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? ''
    const attachment = node.disposition?.toLowerCase() === 'attachment' || (filename !== '' && !type.startsWith('text/'))
    if (attachment) {
      attachments.push({ filename, contentType: type, size: node.size ?? 0 })
      return
    }
    if (type === 'text/plain' && parts.textPart === null) parts.textPart = node.part ?? '1'
    else if (type === 'text/html' && parts.htmlPart === null) parts.htmlPart = node.part ?? '1'
  }
  if (structure) walk(structure)
  return { parts, attachments }
}

/** Prefers the text/plain part, falls back to flattening the HTML part, and returns '' when there is neither. */
export async function fetchText(client: Pick<ImapClient, 'download'>, uid: number, parts: MailBodyParts): Promise<string> {
  if (parts.textPart) {
    const { content } = await client.download(uid, parts.textPart, { uid: true, maxBytes: MAX_BODY_BYTES })
    return normalizeText((await readBytes(content)).toString('utf8'))
  }
  if (parts.htmlPart) {
    const { meta, content } = await client.download(uid, parts.htmlPart, { uid: true, maxBytes: MAX_BODY_BYTES })
    const html = await readBytes(content)
    return normalizeText(htmlToPlain(new TextDecoder(htmlEncoding(html, meta?.charset)).decode(html)))
  }
  return ''
}

/**
 * The encoding of an HTML part, as the HTML standard has a browser decide it: a byte order mark first, then the
 * charset of the transport when it is supported, then the meta tags of the head, and UTF-8 otherwise.
 */
export function htmlEncoding(html: Buffer, mimeCharset: string | undefined): string {
  return byteOrderMark(html) ?? transportEncoding(mimeCharset) ?? metaEncoding(html) ?? 'utf-8'
}

/**
 * The encoding the bytes are in by the charset of the MIME header, imapflow being the transport. It converts a part
 * to UTF-8 by a charset it knows and then reports utf-8, and leaves ASCII as it is, which reads alike as UTF-8. A
 * part whose charset it does not know, such as Outlook's `_iso-2022-jp$ESC` or `unknown-8bit`, it passes on as
 * written with the label kept; a label the Encoding Standard does not know either is not supported, and the meta
 * tags decide.
 */
function transportEncoding(mimeCharset: string | undefined): string | null {
  if (!mimeCharset) return null
  if (['utf8', 'ascii', 'usascii'].includes(mimeCharset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) return 'utf-8'
  return encodingOf(mimeCharset)
}

function byteOrderMark(bytes: Buffer): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  return null
}

/**
 * The encoding the first meta tag of the head with a label of the Encoding Standard declares: its charset
 * attribute, or the charset of its content when its http-equiv is Content-Type. A label the standard does not know,
 * such as cp932, is passed over. A document that declares UTF-16 in a meta tag is read as UTF-8, since a meta tag
 * readable as ASCII cannot be in UTF-16, and x-user-defined is read as windows-1252. Comments are skipped, as the
 * HTML standard's prescan skips them, and the search goes on past the prescan's first 1024 bytes to the end of the
 * head, as Chromium's does. A meta tag after the head is not read: in mail it is mostly the head of a message
 * quoted or forwarded in the body, which describes that message rather than this one.
 */
function metaEncoding(html: Buffer): string | null {
  const head = html.toString('latin1').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/<\/head\b|<body\b/i)[0]
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>()
    for (const [, name, value = ''] of tag.slice(5).matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      if (!attributes.has(name.toLowerCase())) attributes.set(name.toLowerCase(), value.replace(/^(["'])(.*)\1$/s, '$2'))
    }
    const label = attributes.get('charset') ?? (attributes.get('http-equiv')?.toLowerCase() === 'content-type' ? contentCharset(attributes.get('content') ?? '') : null)
    const encoding = label === null ? null : encodingOf(label)
    if (encoding === 'utf-16be' || encoding === 'utf-16le') return 'utf-8'
    if (encoding === 'x-user-defined') return 'windows-1252'
    if (encoding) return encoding
  }
  return null
}

/** The charset in the content of a Content-Type meta tag, such as `text/html; charset=Shift_JIS`. */
const contentCharset = (content: string): string | null => /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;"']+))/i.exec(content)?.slice(1).find((value) => value !== undefined) ?? null

/** The name the Encoding Standard gives a label, which TextDecoder resolves, or null for a label it does not know. */
function encodingOf(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding
  } catch {
    return null
  }
}

export function htmlToPlain(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' }
    ]
  })
}

const normalizeText = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
