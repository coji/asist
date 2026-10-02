import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

/**
 * Until version 12 a mail account knew only its own address, so an older file, which the app has to open before
 * anything else, reads each account with no other addresses rather than refusing it.
 */
describe('the mail accounts of a settings file written before they listed the other addresses the user sends from', () => {
  const v11 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v11.json'), 'utf8')) as Record<string, unknown>
  const account = {
    id: 'a1',
    label: '仕事',
    email: 'me@example.com',
    name: '私',
    provider: 'gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    folders: { sent: '[Gmail]/Sent Mail', archive: '[Gmail]/All Mail', trash: '[Gmail]/Trash' }
  }

  it('opens every account as it was, with no other addresses', () => {
    const accounts = [account, { ...account, id: 'a2', label: '個人', email: 'other@example.com' }]
    const opened = openStoredContent(SETTINGS_FORMAT, { ...v11, mail: { enabled: true, accounts, defaultAccountId: 'a1', syncDays: 30, notifyNewMail: true } })
    expect(opened.value.mail.accounts).toEqual(accounts.map((one) => ({ ...one, otherAddresses: [] })))
  })
})
