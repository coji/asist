/**
 * The text of the landing page in one language. A key ending in Html may hold <br />, <mark> or
 * <span class="nw"> (a phrase kept on one line), and nothing else.
 */
export interface LandingText {
  meta: { title: string; description: string; ogDescription: string }
  nav: { label: string; footerLabel: string; home: string; cards: string; apps: string; agent: string; memory: string; start: string; docs: string; github: string; language: string }
  hero: { titleHtml: string; leadHtml: string; start: string; platforms: string; free: string; artAlt: string; youHtml: string; meHtml: string; cardAlt: string }
  home: { title: string; headline: string; body: string; shotAlt: string; card: string; talk: string; apps: string }
  cards: { title: string; headline: string; body: string; label: string; weather: string; map: string; calendar: string; fx: string; mailDraft: string; todo: string; timer: string; note: string }
  apps: { title: string; headline: string; body: string; agent: string; tasks: string; notes: string; mail: string; memory: string; calendar: string; settings: string }
  agent: { title: string; headline: string; body: string; artAlt: string; askHtml: string; confirm: string; confirmMeta: string; cancel: string; startJob: string }
  memory: { title: string; headline: string; body: string; artAlt: string; diaryDate: string; diaryTitle: string; diaryBody: string; noteHtml: string }
  start: { title: string; sub: string; downloadMac: string; downloadWindows: string; setup: string; mac: string; windows: string; bubble: string; step1: string; step2: string; step3: string }
  footer: { privacy: string; analytics: string; analyticsLink: string }
}

export const ja: LandingText = {
  meta: {
    title: 'ASIST — 話しかけるだけで、予定もメールも片づく。',
    description: 'ASIST は Mac と Windows で使えるリアルタイムアシスタントです。話すだけであなたの作業をサポートします。天気や予定やメールは会話の横のカードに出て、時間のかかる作業は Agent に任せられます。',
    ogDescription: 'Mac と Windows で使えるリアルタイムアシスタント。話すだけであなたの作業をサポートします。'
  },
  nav: {
    label: 'ページ内',
    footerLabel: 'フッター',
    home: 'ホーム画面',
    cards: 'カード',
    apps: 'ミニアプリ',
    agent: 'Agent',
    memory: '記憶',
    start: 'はじめる',
    docs: 'ドキュメント',
    github: 'GitHub で見る',
    language: '言語'
  },
  hero: {
    titleHtml: '話しかけるだけで、<br />予定もメールも片づく。',
    leadHtml: 'ASIST は Mac と Windows で使える<span class="nw">リアルタイムアシスタントです。</span><br />話すだけであなたの作業をサポートします。',
    start: 'はじめる',
    platforms: 'macOS 14 以降・Windows 11',
    free: '無料・オープンソース',
    artAlt: 'クレイのジオラマ。机で Mac に向かう ASIST と、となりのロボット',
    youHtml: 'ねぇ ASIST、<br />今日の予定は?',
    meHtml: '今日の予定は<br />こんな感じだよ',
    cardAlt: '今日の予定のカード'
  },
  home: {
    title: 'ホーム画面',
    headline: '会話とカードがひとつの画面に。',
    body: '真ん中で話すと、答えのカードが左右に並びます。下の Dock からはミニアプリを開けます。',
    shotAlt: 'ASIST のホーム画面。中央に会話、左に為替のカード、右に天気のカード、下に Dock が並んでいる',
    card: 'カード',
    talk: '会話',
    apps: 'ミニアプリ'
  },
  cards: {
    title: 'カード',
    headline: '必要な情報をすぐに。',
    body: '天気、カレンダー、メールの下書き、To-Do、為替、ニュース、地図、タイマーなどを、声で答えながら会話の横のカードに出します。',
    label: 'カードの例',
    weather: '天気のカード',
    map: '地図のカード',
    calendar: '予定のカード',
    fx: '為替のカード',
    mailDraft: 'メールの下書きのカード',
    todo: 'やることのカード',
    timer: 'タイマーのカード',
    note: '「明日の天気は?」'
  },
  apps: {
    title: 'ミニアプリ',
    headline: '直感的に使える。',
    body: 'ミニアプリから直接 Agent のジョブ、タスク、メモ、メール、記憶、カレンダーを開けます。「カレンダーで来週を開いて」と会話から開くこともできます。',
    agent: 'Agent',
    tasks: 'タスク',
    notes: 'メモ',
    mail: 'メール',
    memory: '記憶',
    calendar: 'カレンダー',
    settings: '設定'
  },
  agent: {
    title: 'Agent',
    headline: '面倒な仕事はすべておまかせ。',
    body: '時間のかかる調べものやファイルの編集は、あなたが承認したあとに codex か claude の CLI へ引き渡します。',
    artAlt: 'クレイのジオラマ。ASIST が書類をロボットに渡している',
    askHtml: 'この資料、<br />まとめておいて',
    confirm: 'Agent のジョブを始めますか?',
    confirmMeta: '作業場所 ~/work/report ・ 読むだけ',
    cancel: 'キャンセル',
    startJob: 'ジョブを始める'
  },
  memory: {
    title: '記憶',
    headline: 'Agent が日記を書いて記憶を整理。',
    body: '毎日 0 時にその日の会話から、あなたのことや ASIST 自身の一日を日記に書きます。次の日の会話はそれを覚えたところから始まります。',
    artAlt: 'クレイのジオラマ。夜、日記を抱えて眠る ASIST',
    diaryDate: '日記 ・ 9月23日(水)',
    diaryTitle: '提案書の下書きを一緒に直した日',
    diaryBody: '昼過ぎに、提案書の下書きを読み上げてほしいと頼まれた。三つ目の節が前の節と同じことを言っていると気づいて、そう伝えた。',
    noteHtml: 'ちゃんと<br />覚えてくれてるんだな…'
  },
  start: {
    title: 'さあ、はじめましょう。',
    sub: 'あなたのコンピュータに、ASIST を。',
    downloadMac: 'Mac 版をダウンロード',
    downloadWindows: 'Windows 版をダウンロード',
    setup: 'セットアップの手順',
    mac: 'macOS 14 以降・Apple Silicon',
    windows: 'Windows 11・x64',
    bubble: 'はじめよう!',
    step1: 'Apple Silicon の Mac か Windows 11 の PC と、会話のモデルの API キーを 1 つ用意します。',
    step2: 'Mac では dmg を開いて、ASIST を「アプリケーション」フォルダに入れます。Windows ではインストーラーを開き、警告が出たら「詳細情報」→「実行」を押します。',
    step3: '初回セットアップで、言語、モデル、声、マイクを選べば話しかけられます。'
  },
  footer: {
    privacy: 'プライバシーポリシー',
    analytics: 'このサイトは、アクセス解析に Cookie を使う Google Analytics を使っています。',
    analyticsLink: 'Google によるデータの使用'
  }
}
