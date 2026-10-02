import type { JsonSchema } from '@shared/conversation'
import type { ConversationLocale, PromptText } from '@shared/conversation-locale'
import {
  FETCHER_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  ToolError,
  bilingual,
  type ToolDefinition
} from '@shared/tool-registry'
import { localIsoWithOffset } from '@shared/calendar'
import { MAIL_VIEWS, mailChangeSchema, mailDraftPatchSchema, mailListQuerySchema, mailSummary, formatAddress, replySubject } from '@shared/mail'
import { catalogByType } from '@shared/panel-catalog'
import { getMailService } from '../mail'
import type { ToolContext } from './tools'
import { badInput, detail } from './tool-error-text'
import { CARD_FIELD, putUpCard } from './cards'

/**
 * The mail tools. Listings and bodies come from the already fetched cache. Sending and replying never
 * send: they show a draft card and wait for the user to press its send button, which is the approval.
 * Archiving, trashing, marking read and starring go through the confirmation dialog first. list_mail
 * and read_mail put up the list card and the message card when asked.
 */

/** The limit on a returned body. Speaking it aloud means summarizing anyway, but it stays long enough not to lose content. */
const READ_RESULT_MAX = 12_000

function accountLabels(): Map<string, string> {
  return new Map(getMailService().status().accounts.map((account) => [account.id, account.label]))
}

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  notConfigured: {
    ja: 'メール連携が設定されていない。設定画面でアカウントを追加すると使えることを伝えること。',
    en: 'Mail is not set up. Tell the user it works once they add an account on the settings screen.'
  },
  readFailed: (reason: string): PromptText => ({
    ja: `メールを読めない: ${reason}。list_mail で id を確かめて呼び直すこと。`,
    en: `The message could not be read: ${reason}. Check the id with list_mail and call again.`
  }),
  changeFailed: (reason: string): PromptText => ({
    ja: `メールを操作できない: ${reason}。理由をユーザーに伝えること。`,
    en: `The mail could not be acted on: ${reason}. Tell the user why.`
  }),
  draftFailed: (reason: string): PromptText => ({
    ja: `下書きを直せない: ${reason}。理由をユーザーに伝えること。`,
    en: `The draft could not be edited: ${reason}. Tell the user why.`
  })
} as const

export function mailTools(locale: ConversationLocale): ToolDefinition<ToolContext>[] {
  return [
    {
      name: 'list_mail',
      description: {
        ja: [
          `取り込み済みのメールの一覧を返す。view は ${MAIL_VIEWS.join(' / ')}(省略で inbox)。query は件名・差出人・本文の部分一致、unreadOnly で未読だけ、accountId でアカウントを絞る(省略で全部)。`,
          '結果は { count, total, accounts: [{ id, label, email, otherAddresses?, unread }], messages: [{ id, account, from, subject, date, unread, starred, attachments?, snippet }] }。accounts の email と otherAddresses(そのアカウントでほかに送信に使っているアドレス)が自分のアドレス(「自分宛て」はこれ)。取り込むのは設定の日数(既定 30 日)の範囲だけで、それより古いメールは出ない。',
          '本文は read_mail で読む。id は read_mail と change_mail に使う。'
        ].join('\n'),
        en: [
          `Returns the list of messages already fetched. view is one of ${MAIL_VIEWS.join(' / ')}, the inbox when left out. query matches part of a subject, a sender or a body, unreadOnly keeps only the unread ones, and accountId narrows it to one account, all of them when left out.`,
          "The result is { count, total, accounts: [{ id, label, email, otherAddresses?, unread }], messages: [{ id, account, from, subject, date, unread, starred, attachments?, snippet }] }. The email in accounts and its otherAddresses, the other addresses the user sends from with that account, are the user's own, which is what \"addressed to me\" means. Only the last however many days the settings say, 30 by default, are fetched, so nothing older appears.",
          'The body is read with read_mail. id is what read_mail and change_mail take.'
        ].join('\n')
      },
      usage: {
        ja: '「未読メールある?」「田中さんからメール来てる?」「今日のメールは?」のように一覧や有無を聞かれたとき。画面に見せるなら card を付ける。ブリーフィングでは unreadOnly で未読だけ拾う',
        en: 'When the user asks what mail has come in, whether anything is unread, or whether someone has written. Set card to show the list on screen as well. In a briefing, use unreadOnly to pick up the unread ones only.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: [...MAIL_VIEWS] },
          query: {
            type: 'string',
            description: bilingual({
              ja: '件名・差出人・本文の部分一致',
              en: 'Matches part of a subject, a sender or a body.'
            })
          },
          unreadOnly: { type: 'boolean' },
          accountId: {
            type: 'string',
            description: bilingual({ ja: 'list_mail の accounts にある id', en: 'An id from accounts in list_mail.' })
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: bilingual({
              ja: '既定 20。既読にする id を集めるときは大きく',
              en: '20 by default; raise it when collecting the ids to mark read.'
            })
          },
          card: CARD_FIELD
        },
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 16_000,
      run: async (input, ctx, signal) => {
        const { card, ...listInput } = input
        const query = mailListQuerySchema.safeParse({ ...listInput, limit: listInput.limit ?? 20 })
        if (!query.success) throw badInput(query.error.issues, locale)
        const service = getMailService()
        const status = service.status()
        if (!status.enabled || status.accounts.length === 0) throw new ToolError(TEXTS.notConfigured)
        if (card === true) {
          await putUpCard('mail', { unreadOnly: query.data.unreadOnly, view: query.data.view, query: query.data.query }, ctx, signal, locale)
        }
        const labels = accountLabels()
        const result = service.list(query.data)
        return {
          count: result.messages.length,
          total: result.total,
          accounts: status.accounts.map((account) => ({
            id: account.id,
            label: account.label,
            email: account.email,
            ...(account.otherAddresses.length ? { otherAddresses: account.otherAddresses } : {}),
            unread: account.unread,
            state: account.state,
            ...(account.error ? { error: account.error } : {})
          })),
          messages: result.messages.map((message) => mailSummary(message, labels.get(message.accountId) ?? message.accountId))
        }
      }
    },
    {
      name: 'read_mail',
      description: {
        ja: 'メールの本文を読む。id は list_mail の結果から。結果は { id, account, from, to, cc, date, subject, attachments, text }。text は本文の文字(HTML は文にしてある)。読んでも既読にはならない(既読にするなら change_mail の markRead)。',
        en: "Reads the body of a message. Take id from the result of list_mail. The result is { id, account, from, to, cc, date, subject, attachments, text }, where text is the body as plain text, HTML already turned into sentences. Reading it does not mark it read; change_mail's markRead does that."
      },
      usage: {
        ja: '「田中さんのメール読んで」「何て書いてある?」のように中身を聞かれたとき。本文をそのまま読み上げず、要点を2〜3文にまとめて話す。一通の中身を話すときは card を付けて画面にも出す',
        en: 'When the user asks you to read a message or what it says. Do not read the body out word for word: give the gist in two or three sentences. When you talk about one message, set card to show it on screen as well.'
      },
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, card: CARD_FIELD },
        required: ['id'],
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: FETCHER_TIMEOUT_MS,
      maxResultChars: READ_RESULT_MAX,
      run: async (input, ctx, signal) => {
        if (input.card === true) await putUpCard('mail-message', { id: String(input.id ?? '') }, ctx, signal, locale)
        try {
          const { message, text } = await getMailService().read(String(input.id ?? ''))
          return {
            id: message.id,
            account: accountLabels().get(message.accountId) ?? message.accountId,
            from: formatAddress(message.from),
            to: message.to.map(formatAddress),
            cc: message.cc.map(formatAddress),
            date: localIsoWithOffset(message.date),
            subject: message.subject,
            attachments: message.attachments.map((item) => item.filename),
            text
          }
        } catch (err) {
          throw new ToolError(TEXTS.readFailed(detail(err, locale)))
        }
      }
    },
    {
      name: 'change_mail',
      description: {
        ja: [
          'メールを送る・返信する・アーカイブする・ゴミ箱へ移す・既読/未読にする・スターを付ける/外す。',
          'send / reply は送らない。下書きカードを画面に出して { drafted: true, draftId, summary } を返し、ユーザーがカードの「送信」を押すと送られる。文面を直してと言われたら update_mail_draft。',
          'archive / trash / markRead / star は実行前に確認画面を表示し、ユーザーのクリック承認後に行う。',
          'send: to/cc は「名前 <addr>」か「addr」の配列、subject と body は文字列、accountId を省くと既定の差出人。reply: id と body(引用は自動で付く)、replyAll で全員に返信。archive / trash / star(starred): id を指定。markRead(read): ids に複数まとめて渡せる(「全部既読にして」は list_mail の unreadOnly で集めた id を全部渡す)。',
          'send も reply も、差出人は必ずそのアカウントの email になる。list_mail の otherAddresses からは送れないので、そのアドレスから送ってと頼まれたら、アカウントの email から送ることになると伝える。',
          '結果は { saved, operation, id, summary } か { cancelled: true } か { drafted: true, draftId, summary }。失敗や時間切れ時は自動で再実行しない。本文の内容はユーザーの言った通りにし、勝手に足さない。宛先や本文が曖昧なら聞き返す。'
        ].join('\n'),
        en: [
          'Sends, replies to, archives, trashes, marks read or unread, and stars or unstars a message.',
          'send and reply do not send anything. They put a draft card on screen and return { drafted: true, draftId, summary }, and the message goes out when the user presses send on that card. When asked to reword it, use update_mail_draft.',
          'archive, trash, markRead and star bring up a confirmation window first and act once the user has clicked it through.',
          'send: to and cc are arrays of either "Name <addr>" or "addr", subject and body are strings, and leaving accountId out uses the default sender. reply: id and body, with the quoted original added by itself, and replyAll to answer everyone. archive, trash and star (starred): give id. markRead (read): ids takes several at once, so marking everything read means passing every id collected with unreadOnly in list_mail.',
          "Both send and reply always go out from the account's own email. Nothing can be sent from the otherAddresses in list_mail, so when asked to send from one of them, tell the user the mail will go out from the account's email instead.",
          'The result is { saved, operation, id, summary }, or { cancelled: true }, or { drafted: true, draftId, summary }. Never retry by yourself after a failure or a timeout. Write the body as the user said it and add nothing of your own. Ask again when the recipient or the body is unclear.'
        ].join('\n')
      },
      usage: {
        ja: 'メールの送信・返信・アーカイブ・ゴミ箱・既読・スターを明示的に頼まれたとき。send / reply は下書きカードになるので「下書きを出しました。見て、送信を押してください」と伝える。archive などは「確認画面で承認してください」と伝えてから呼ぶ',
        en: 'When the user explicitly asks to send, reply to, archive, trash, mark read or star a message. send and reply produce a draft card, so tell them the draft is up and to look it over and press send. For archiving and the rest, tell them to approve it in the confirmation window before you call it.'
      },
      // Some providers reject a schema whose top level is not an object, so the discriminated union is validated again at run time.
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['send', 'reply', 'archive', 'trash', 'markRead', 'star'] },
          id: {
            type: 'string',
            description: bilingual({
              ja: 'reply / archive / trash / star の対象',
              en: 'What reply, archive, trash or star acts on.'
            })
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: bilingual({ ja: 'markRead の対象。複数可', en: 'What markRead acts on; there may be several.' })
          },
          accountId: {
            type: 'string',
            description: bilingual({ ja: 'send の差出人。省略で既定', en: 'The sender for send; the default one when left out.' })
          },
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string', description: bilingual({ ja: 'send / reply の本文', en: 'The body of a send or a reply.' }) },
          replyAll: { type: 'boolean' },
          read: {
            type: 'boolean',
            description: bilingual({
              ja: 'markRead で true なら既読、false なら未読',
              en: 'For markRead, true marks read and false marks unread.'
            })
          },
          starred: {
            type: 'boolean',
            description: bilingual({
              ja: 'star で true なら付ける、false なら外す',
              en: 'For star, true adds the star and false takes it off.'
            })
          }
        },
        required: ['operation'],
        additionalProperties: false
      } as JsonSchema,
      parallel: false,
      timeoutMs: 300_000,
      maxResultChars: 3_000,
      run: async (input, ctx, signal) => {
        const parsed = mailChangeSchema.safeParse(input)
        if (!parsed.success) throw badInput(parsed.error.issues, locale)
        let result
        try {
          result = await getMailService().change(parsed.data, signal, 'agent')
        } catch (err) {
          throw new ToolError(TEXTS.changeFailed(detail(err, locale)))
        }
        if ('drafted' in result) showDraftCard(ctx, result.draftId)
        return result
      }
    },
    {
      name: 'update_mail_draft',
      description: {
        ja: '出した下書きカードの文面を直す。draftId は change_mail の結果から。body / subject / to / cc を渡した項目だけ変える(返信の下書きは body だけ)。結果は { draftId, subject, to, body }。送るのはユーザーがカードの「送信」を押したときで、このツールでは送らない。',
        en: 'Rewords the draft card already on screen. Take draftId from the result of change_mail. Only the fields you pass among body, subject, to and cc change, and a reply draft takes body alone. The result is { draftId, subject, to, body }. The message goes out when the user presses send on the card; this tool never sends anything.'
      },
      usage: {
        ja: '「もう少し丁寧に」「件名を変えて」のように、出した下書きを直すよう言われたとき。直したあとの本文を一文で伝える',
        en: 'When the user asks you to change the draft already on screen, for instance to make it more polite or to change the subject. Say what the reworded body now says in one sentence.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['draftId'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 3_000,
      run: (input, ctx) => {
        const { draftId, ...patch } = input
        const parsed = mailDraftPatchSchema.safeParse(patch)
        if (!parsed.success) throw badInput(parsed.error.issues, locale)
        try {
          const draft = getMailService().draftUpdate(String(draftId ?? ''), parsed.data)
          showDraftCard(ctx, draft.id)
          return { draftId: draft.id, subject: draft.reply ? replySubject(draft.reply.subject) : draft.subject, to: draft.reply ? draft.reply.to.map(formatAddress) : draft.to, body: draft.body }
        } catch (err) {
          throw new ToolError(TEXTS.draftFailed(detail(err, locale)))
        }
      }
    }
  ]
}

/** Shows the draft card in the right dock, or brings it forward if it is already there. The renderer draws its content from the draft it receives. */
function showDraftCard(ctx: ToolContext, draftId: string): void {
  const entry = catalogByType.get('mail-draft')
  if (!entry) throw new Error('the panel catalog has no mail-draft entry')
  const props = { draftId }
  ctx.emit({ type: 'panel', turnId: ctx.turnId, event: { op: 'create', key: entry.key(props), type: 'mail-draft', slot: entry.slot, props, state: 'ready' } })
}
