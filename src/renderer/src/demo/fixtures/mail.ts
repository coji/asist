import { messageIdOf, quotation, replyRecipients, type MailAccount, type MailDraft, type MailMessage, type MailReply, type MailStatus } from '@shared/mail'

/**
 * The mail of the demo. Two accounts, work (Gmail) and personal (iCloud), get messages built relative to
 * the time the demo runs, so that each account has at least one unread, starred and attached message and
 * one thread. The bodies live here too, and mailRead returns them.
 */

const HOUR = 3_600_000
const now = Date.now()
const ago = (hours: number): number => now - hours * HOUR

export const DEMO_MAIL_ACCOUNTS: MailAccount[] = [
  {
    id: 'demo-work',
    label: '仕事',
    email: 'sakasegawa@example.co.jp',
    name: '逆瀬川',
    provider: 'gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    folders: { sent: '[Gmail]/Sent Mail', archive: '[Gmail]/All Mail', trash: '[Gmail]/Trash' }
  },
  {
    id: 'demo-home',
    label: '個人',
    email: 'sakasegawa@example.com',
    name: '',
    provider: 'icloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    folders: { sent: 'Sent Messages', archive: 'Archive', trash: 'Deleted Messages' }
  }
]

interface Seed {
  account: 'demo-work' | 'demo-home'
  folder: MailMessage['folder']
  uid: number
  from: MailMessage['from']
  to?: MailMessage['to']
  cc?: MailMessage['cc']
  replyTo?: MailMessage['replyTo']
  subject: string
  at: number
  text: string
  unread?: boolean
  starred?: boolean
  answered?: boolean
  attachments?: MailMessage['attachments']
  thread?: string
}

const me = { name: '逆瀬川', address: 'sakasegawa@example.co.jp' }
const tanaka = { name: '田中 誠', address: 'tanaka@example.co.jp' }
const suzuki = { name: '鈴木 花', address: 'hana.suzuki@example.co.jp' }
const design = { name: 'Design Weekly', address: 'news@design-weekly.example' }
const dentist = { name: 'さくら歯科', address: 'info@sakura-dental.example' }
const mom = { name: '母', address: 'mother@example.com' }
const store = { name: 'ヨドバシ.com', address: 'order@yodobashi.example' }
const recruiting = { name: '採用チーム', address: 'recruiting@example.co.jp' }

const SEEDS: Seed[] = [
  {
    account: 'demo-work',
    folder: 'inbox',
    uid: 1041,
    from: tanaka,
    to: [me],
    subject: '来週の打合せの候補日',
    at: ago(0.4),
    unread: true,
    thread: 'meeting',
    text: `逆瀬川さん\n\nお疲れさまです。田中です。\n来週の打合せですが、火曜 14時か水曜 10時のどちらかでいかがでしょうか。\n議題は先日の予約画面のレビュー結果の続きです。\n\nよろしくお願いします。\n田中`
  },
  {
    account: 'demo-work',
    folder: 'inbox',
    uid: 1040,
    from: suzuki,
    to: [me],
    cc: [tanaka],
    replyTo: [recruiting],
    subject: 'Re: 採用面談の候補日',
    at: ago(2),
    unread: true,
    starred: true,
    thread: 'interview',
    attachments: [{ filename: '候補者リスト.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 24_576 }],
    text: `逆瀬川さん\n\n候補日を3つ挙げました。添付に候補者の一覧も付けています。\n・9/24(水) 15:00\n・9/25(木) 11:00\n・9/26(金) 16:00\n\n都合のよい日をお知らせください。\n鈴木`
  },
  {
    account: 'demo-work',
    folder: 'inbox',
    uid: 1039,
    from: design,
    to: [me],
    subject: 'Design Weekly #212: 予約フォームの入力を減らす',
    at: ago(9),
    text: `今週の Design Weekly\n\n1. 予約フォームの入力項目をどう減らすか\n2. ダークテーマの数字の見せ方\n3. 空き状況の一覧の見せ方\n\n続きはサイトでどうぞ。`
  },
  {
    account: 'demo-work',
    folder: 'inbox',
    uid: 1038,
    from: tanaka,
    to: [me],
    subject: '予約画面 レビューのメモ',
    at: ago(26),
    answered: true,
    thread: 'meeting',
    text: `逆瀬川さん\n\n今日のレビューのメモです。\n- 空き枠の一覧は見やすい\n- 確認のボタンをもう少し目立たせたい\n- キャンセルの手順は一画面にまとめたい\n\n田中`
  },
  {
    account: 'demo-work',
    folder: 'inbox',
    uid: 1035,
    from: suzuki,
    to: [me],
    subject: '経費精算の締め切り',
    at: ago(50),
    text: `今月の経費精算は 9/20(土) までにお願いします。\n領収書はいつものフォルダに入れてください。\n鈴木`
  },
  {
    account: 'demo-work',
    folder: 'sent',
    uid: 512,
    from: me,
    to: [tanaka],
    subject: 'Re: 予約画面 レビューのメモ',
    at: ago(25),
    thread: 'meeting',
    text: `田中さん\n\nメモありがとうございます。確認のボタンは色を変えて試してみます。\n逆瀬川`
  },
  {
    account: 'demo-work',
    folder: 'archive',
    uid: 9001,
    from: { name: 'GitHub', address: 'noreply@github.example' },
    to: [me],
    subject: '[example-inc/booking-web] Add the waitlist page (#42)',
    at: ago(80),
    text: `Merged #42 into main.`
  },
  {
    account: 'demo-home',
    folder: 'inbox',
    uid: 301,
    from: dentist,
    to: [{ name: '', address: 'sakasegawa@example.com' }],
    subject: '【ご予約確認】9/18(木) 10:30',
    at: ago(5),
    unread: true,
    text: `逆瀬川 様\n\n9月18日(木) 10:30 のご予約を承りました。\n保険証をお持ちください。変更の際はお電話でご連絡ください。\n\nさくら歯科`
  },
  {
    account: 'demo-home',
    folder: 'inbox',
    uid: 300,
    from: mom,
    to: [{ name: '', address: 'sakasegawa@example.com' }],
    subject: '連休の予定',
    at: ago(30),
    starred: true,
    text: `連休は帰ってくるの？\n梨を送ろうと思うけど、いつがいい？`
  },
  {
    account: 'demo-home',
    folder: 'inbox',
    uid: 298,
    from: store,
    to: [{ name: '', address: 'sakasegawa@example.com' }],
    subject: 'ご注文の商品を発送しました',
    at: ago(70),
    attachments: [{ filename: '納品書.pdf', contentType: 'application/pdf', size: 88_120 }],
    text: `ご注文いただいた USB-C ケーブルを発送しました。お届けは明日の予定です。`
  }
]

export const DEMO_MAIL_BODIES = new Map<string, string>()

/** The UIDVALIDITY of every demo folder, which the demo never renews. */
export const DEMO_UID_VALIDITY = '1'

export const DEMO_MAIL_MESSAGES: MailMessage[] = SEEDS.map((seed) => {
  const id = messageIdOf(seed.account, seed.folder, DEMO_UID_VALIDITY, seed.uid)
  DEMO_MAIL_BODIES.set(id, seed.text)
  return {
    id,
    accountId: seed.account,
    folder: seed.folder,
    uid: seed.uid,
    messageId: `<${seed.uid}@demo.example>`,
    threadId: seed.thread ? `m:<${seed.thread}@demo.example>` : `m:<${seed.uid}@demo.example>`,
    subject: seed.subject,
    from: seed.from,
    to: seed.to ?? [me],
    cc: seed.cc ?? [],
    replyTo: seed.replyTo ?? [],
    date: seed.at,
    snippet: seed.text.replace(/\s+/g, ' ').trim().slice(0, 200),
    unread: seed.unread ?? false,
    starred: seed.starred ?? false,
    answered: seed.answered ?? false,
    attachments: seed.attachments ?? [],
    size: seed.text.length * 3,
    labels: [],
    bodyFetched: true
  }
})

export function demoMailStatus(messages: readonly MailMessage[]): MailStatus {
  const accounts = DEMO_MAIL_ACCOUNTS.map((account) => {
    const unread = messages.filter((m) => m.accountId === account.id && m.folder === 'inbox' && m.unread)
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      provider: account.provider,
      state: 'connected' as const,
      error: '',
      lastSyncAt: now - 3 * 60_000,
      unread: unread.length,
      unreadRecent: unread.filter((m) => now - m.date <= 24 * HOUR).length
    }
  })
  return {
    enabled: true,
    accounts,
    unread: accounts.reduce((sum, a) => sum + a.unread, 0),
    unreadRecent: accounts.reduce((sum, a) => sum + a.unreadRecent, 0)
  }
}

/** For the mail card, which summarizes the inbox with unread messages first and the newest first. */
export const DEMO_MAIL_CARD = {
  accounts: DEMO_MAIL_ACCOUNTS.map((a) => ({ id: a.id, label: a.label })),
  unread: DEMO_MAIL_MESSAGES.filter((m) => m.folder === 'inbox' && m.unread).length,
  messages: DEMO_MAIL_MESSAGES.filter((m) => m.folder === 'inbox')
    .sort((a, b) => Number(b.unread) - Number(a.unread) || b.date - a.date)
    .slice(0, 8)
}

/** A reply settled from a demo message, as main's settleReply makes one. The demo keeps no References, so the chain is the message itself. */
export function demoReplyOf(message: MailMessage, replyAll: boolean): MailReply {
  const account = DEMO_MAIL_ACCOUNTS.find((a) => a.id === message.accountId) ?? DEMO_MAIL_ACCOUNTS[0]
  return {
    id: message.id,
    subject: message.subject,
    from: message.from,
    replyAll,
    ...replyRecipients(message, account.email, replyAll),
    inReplyTo: message.messageId,
    references: [message.messageId],
    quote: quotation({ date: message.date, from: message.from, text: DEMO_MAIL_BODIES.get(message.id) ?? '' })
  }
}

const interview = DEMO_MAIL_MESSAGES.find((m) => m.folder === 'inbox' && m.uid === 1040)!

/**
 * The drafts: one new message asked for by voice, one reply to everyone on a message in the inbox whose
 * Reply-To names a team address, so that the reply goes to that address and not to its sender, and one whose
 * send started, as when it went out but could not be removed, which can only be discarded.
 */
export const DEMO_MAIL_DRAFTS: MailDraft[] = [
  {
    id: 'draft-greeting',
    accountId: 'demo-work',
    to: ['田中 誠 <tanaka@example.co.jp>'],
    cc: [],
    subject: '季節のご挨拶',
    body: '拝啓\n暑さも和らぎ、秋の気配が感じられる頃となりました。いかがお過ごしでしょうか。\n時節柄、どうぞご自愛くださいませ。\n敬具',
    reply: null,
    origin: 'agent',
    createdAt: ago(0.1),
    updatedAt: ago(0.1),
    sendStartedAt: null
  },
  {
    id: 'draft-reply-interview',
    accountId: 'demo-work',
    to: [],
    cc: [],
    subject: '',
    body: '鈴木さん\n\n9/25(木) 11:00 でお願いします。',
    reply: demoReplyOf(interview, true),
    origin: 'agent',
    createdAt: ago(1),
    updatedAt: ago(1),
    sendStartedAt: null
  },
  {
    id: 'draft-started',
    accountId: 'demo-work',
    to: ['佐藤 美咲 <sato@example.co.jp>'],
    cc: [],
    subject: '打合せの資料',
    body: '佐藤さん\n\n本日の打合せの資料をお送りします。ご確認ください。',
    reply: null,
    origin: 'screen',
    createdAt: ago(3),
    updatedAt: ago(3),
    sendStartedAt: ago(2.9)
  }
]

/** The single-message card, as asked for by "田中さんのメール読んで" ("read Tanaka's mail"): the first message in the inbox and its body. */
export const DEMO_MAIL_MESSAGE_CARD = (() => {
  const message = DEMO_MAIL_MESSAGES.find((m) => m.folder === 'inbox' && m.uid === 1041)!
  return { id: message.id, message, accountLabel: '仕事', text: DEMO_MAIL_BODIES.get(message.id) ?? '' }
})()
