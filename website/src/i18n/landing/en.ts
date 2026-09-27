import type { LandingText } from './ja'

export const en: LandingText = {
  meta: {
    title: 'ASIST — just talk, and your schedule and mail get handled.',
    description: 'ASIST is a realtime assistant for Mac and Windows. Just talk, and it helps with your work. Weather, events and mail appear as cards beside the conversation, and work that takes time goes to an agent.',
    ogDescription: 'A realtime assistant for Mac and Windows. Just talk, and it helps with your work.'
  },
  nav: {
    label: 'On this page',
    footerLabel: 'Footer',
    home: 'Home screen',
    cards: 'Cards',
    apps: 'Mini apps',
    agent: 'Agent',
    memory: 'Memory',
    start: 'Get started',
    docs: 'Docs',
    github: 'View on GitHub',
    language: 'Language'
  },
  hero: {
    titleHtml: 'Just talk, and<br />your schedule and mail<br />get handled.',
    leadHtml: 'ASIST is a realtime assistant <span class="nw">for Mac and Windows.</span><br />Just talk, and it helps with your work.',
    start: 'Get started',
    platforms: 'macOS 14 or later · Windows 11',
    free: 'Free and open source',
    artAlt: 'A clay diorama: ASIST at a desk facing a Mac, with a robot beside it',
    youHtml: 'Hey ASIST,<br />what’s on today?',
    meHtml: 'Here’s your<br />day',
    cardAlt: 'A card with today’s events'
  },
  home: {
    title: 'Home screen',
    headline: 'The conversation and the cards, on one screen.',
    body: 'Talk in the middle, and the cards with the answers line up on either side. The Dock at the bottom opens the mini apps.',
    shotAlt: 'The home screen of ASIST: the conversation in the middle, an exchange rate card on the left, a weather card on the right and the Dock below',
    card: 'Card',
    talk: 'Conversation',
    apps: 'Mini apps'
  },
  cards: {
    title: 'Cards',
    headline: 'What you need, right away.',
    body: 'Weather, the calendar, mail drafts, to-dos, exchange rates, news, maps, timers and more appear as cards beside the conversation while ASIST answers aloud.',
    label: 'Examples of cards',
    weather: 'A weather card',
    map: 'A map card',
    calendar: 'An events card',
    fx: 'An exchange rate card',
    mailDraft: 'A mail draft card',
    todo: 'A to-do card',
    timer: 'A timer card',
    note: '“What’s the weather tomorrow?”'
  },
  apps: {
    title: 'Mini apps',
    headline: 'Easy to use.',
    body: 'Open Agent jobs, tasks, notes, mail, memory and the calendar straight from the mini apps, or from the conversation: “Open next week in the calendar.”',
    agent: 'Agent',
    tasks: 'Tasks',
    notes: 'Notes',
    mail: 'Mail',
    memory: 'Memory',
    calendar: 'Calendar',
    settings: 'Settings'
  },
  agent: {
    title: 'Agent',
    headline: 'Hand off the tedious work.',
    body: 'Research and file edits that take time go to the codex or claude CLI, once you approve them.',
    artAlt: 'A clay diorama: ASIST handing papers to a robot',
    askHtml: 'Could you sum up<br />these papers?',
    confirm: 'Start this job?',
    confirmMeta: 'Working directory ~/work/report · Read only',
    cancel: 'Cancel',
    startJob: 'Start job'
  },
  memory: {
    title: 'Memory',
    headline: 'An agent keeps a diary and tidies up what it remembers.',
    body: 'Every night at midnight, it writes a diary from the day’s conversations: about you, and about its own day. The next day’s conversation starts from what it remembers.',
    artAlt: 'A clay diorama: ASIST asleep at night, holding its diary',
    diaryDate: 'Diary · Wednesday, September 23',
    diaryTitle: 'The day we fixed the proposal draft together',
    diaryBody: 'In the early afternoon I was asked to read the proposal draft aloud. I noticed the third section said the same thing as the one before it, and said so.',
    noteHtml: 'It really does<br />remember…'
  },
  start: {
    title: 'Let’s get started.',
    sub: 'ASIST, on your computer.',
    download: 'Download',
    setup: 'Setup guide',
    mac: 'macOS 14 or later · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: 'Let’s go!',
    step1: 'Get an Apple Silicon Mac or a Windows 11 PC, and an API key for one conversation model.',
    step2: 'On a Mac, open the dmg and drag ASIST into Applications. On Windows, open the installer, and if a warning appears, click “More info”, then “Run anyway”.',
    step3: 'Choose the language, model, voice and microphone in the first-run setup, and start talking.'
  },
  footer: {
    analytics: 'This site uses Google Analytics, which sets cookies, to count visits.',
    analyticsLink: 'How Google uses data'
  }
}
