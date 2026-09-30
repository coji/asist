/**
 * The names of the screens and states the demo can open (/screens/<name>). The shell's list (catalog.ts)
 * is built from them, and views.ts holds how to open each one under the same name, so a name that
 * appears in only one of the two fails to type-check. This file loads neither the stores nor the voice
 * modules, so tests can import it.
 */
export type ScreenGroup = '画面' | '設定のページ' | '起動と確認'

export const SCREENS = {
  conversation: { label: '会話画面', group: '画面' },
  'conversation/cards': { label: '会話画面にカードを出す', group: '画面' },
  calendar: { label: 'カレンダー', group: '画面' },
  settings: { label: '設定', group: '画面' },
  jobs: { label: 'Agent', group: '画面' },
  tasks: { label: 'タスク', group: '画面' },
  mail: { label: 'メール', group: '画面' },
  memory: { label: '記憶', group: '画面' },
  notes: { label: 'メモ', group: '画面' },
  'notes/note': { label: 'メモ(会話から一件を開く)', group: '画面' },
  'mail/message': { label: 'メール(会話からメッセージを開く)', group: '画面' },
  'mail/draft-started': { label: 'メール(送信を始めた下書き)', group: '画面' },
  'calendar/event': { label: 'カレンダー(会話から週表示で予定を開く)', group: '画面' },
  'settings/conversation': { label: '会話', group: '設定のページ' },
  'settings/voice': { label: '声', group: '設定のページ' },
  'settings/persona': { label: 'キャラクター', group: '設定のページ' },
  'settings/memory': { label: '記憶', group: '設定のページ' },
  'settings/agent': { label: 'Agent', group: '設定のページ' },
  'settings/connections': { label: 'カレンダーとメール', group: '設定のページ' },
  'settings/connections/google': { label: 'カレンダーとメール(Google カレンダーにログイン済み)', group: '設定のページ' },
  'settings/connections/google-signed-out': { label: 'カレンダーとメール(Google カレンダーに未ログイン)', group: '設定のページ' },
  'settings/connections/google-unreadable': { label: 'カレンダーとメール(Google のログインを読めない)', group: '設定のページ' },
  'settings/language': { label: '言語と地域', group: '設定のページ' },
  'settings/appearance': { label: '見た目', group: '設定のページ' },
  'settings/api-keys': { label: 'API キー', group: '設定のページ' },
  'settings/usage': { label: 'API の料金', group: '設定のページ' },
  'settings/about': { label: 'このアプリについて', group: '設定のページ' },
  'settings/memory/preparing': { label: '記憶(意味検索を準備中)', group: '設定のページ' },
  'settings/memory/converting': { label: '記憶(記憶を変換中)', group: '設定のページ' },
  setup: { label: '初回セットアップ', group: '起動と確認' },
  'setup/key-failed': { label: 'セットアップ(キーの認証に失敗)', group: '起動と確認' },
  'setup/mic-denied': { label: 'セットアップ(マイクが不許可)', group: '起動と確認' },
  'setup/tts-missing': { label: 'セットアップ(読み上げのアプリがない)', group: '起動と確認' },
  'setup/live-key-failed': { label: 'セットアップ(音声モデルのキーの認証に失敗)', group: '起動と確認' },
  safety: { label: 'リスクの確認(セットアップを終えた人)', group: '起動と確認' },
  boot: { label: '起動中', group: '起動と確認' },
  'boot/error': { label: '起動の失敗', group: '起動と確認' },
  confirm: { label: '承認の確認', group: '起動と確認' },
  toasts: { label: '通知', group: '起動と確認' }
} as const satisfies Record<string, { label: string; group: ScreenGroup }>

export type ScreenName = keyof typeof SCREENS
