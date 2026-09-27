import type { LandingText } from './ja'

export const de: LandingText = {
  meta: {
    title: 'ASIST — einfach sprechen, und Termine und Mails sind erledigt.',
    description: 'ASIST ist ein Echtzeit-Assistent für Mac und Windows. Sie sprechen einfach, und er unterstützt Sie bei der Arbeit. Wetter, Termine und Mails erscheinen als Karten neben dem Gespräch, und was länger dauert, übernimmt ein Agent.',
    ogDescription: 'Ein Echtzeit-Assistent für Mac und Windows. Sie sprechen einfach, und er unterstützt Sie bei der Arbeit.'
  },
  nav: {
    label: 'Auf dieser Seite',
    footerLabel: 'Fußzeile',
    home: 'Startbildschirm',
    cards: 'Karten',
    apps: 'Mini-Apps',
    agent: 'Agent',
    memory: 'Gedächtnis',
    start: 'Loslegen',
    docs: 'Dokumentation',
    github: 'Auf GitHub ansehen',
    language: 'Sprache'
  },
  hero: {
    titleHtml: 'Einfach sprechen,<br />und Termine und Mails<br />sind erledigt.',
    leadHtml: 'ASIST ist ein <span class="nw">Echtzeit-Assistent</span> <span class="nw">für Mac und Windows.</span><br />Sie sprechen einfach, und er hilft Ihnen bei der Arbeit.',
    start: 'Loslegen',
    platforms: 'macOS 14 oder neuer · Windows 11',
    free: 'Kostenlos und Open Source',
    artAlt: 'Ein Diorama aus Knete: ASIST am Schreibtisch vor einem Mac, daneben ein Roboter',
    youHtml: 'Hey ASIST,<br />was steht heute an?',
    meHtml: 'Das ist<br />Ihr Tag',
    cardAlt: 'Eine Karte mit den Terminen von heute'
  },
  home: {
    title: 'Startbildschirm',
    headline: 'Gespräch und Karten auf einem Bildschirm.',
    body: 'In der Mitte sprechen Sie, links und rechts reihen sich die Karten mit den Antworten auf. Über das Dock unten öffnen Sie die Mini-Apps.',
    shotAlt: 'Der Startbildschirm von ASIST: in der Mitte das Gespräch, links eine Wechselkurskarte, rechts eine Wetterkarte und unten das Dock',
    card: 'Karte',
    talk: 'Gespräch',
    apps: 'Mini-Apps'
  },
  cards: {
    title: 'Karten',
    headline: 'Was Sie brauchen, sofort zur Hand.',
    body: 'Wetter, Kalender, Mail-Entwürfe, To-dos, Wechselkurse, Nachrichten, Landkarten, Timer und mehr erscheinen als Karten neben dem Gespräch, während ASIST laut antwortet.',
    label: 'Beispiele für Karten',
    weather: 'Eine Wetterkarte',
    map: 'Eine Karte mit einem Kartenausschnitt',
    calendar: 'Eine Terminkarte',
    fx: 'Eine Wechselkurskarte',
    mailDraft: 'Eine Karte mit einem Mail-Entwurf',
    todo: 'Eine To-do-Karte',
    timer: 'Eine Timer-Karte',
    note: '„Wie wird das Wetter morgen?“'
  },
  apps: {
    title: 'Mini-Apps',
    headline: 'Einfach zu bedienen.',
    body: 'Agent-Jobs, Aufgaben, Notizen, Mail, Gedächtnis und Kalender öffnen Sie direkt über die Mini-Apps oder im Gespräch: „Zeig mir nächste Woche im Kalender.“',
    agent: 'Agent',
    tasks: 'Aufgaben',
    notes: 'Notizen',
    mail: 'Mail',
    memory: 'Gedächtnis',
    calendar: 'Kalender',
    settings: 'Einstellungen'
  },
  agent: {
    title: 'Agent',
    headline: 'Lästige Arbeit einfach abgeben.',
    body: 'Recherchen und Änderungen an Dateien, die Zeit brauchen, gehen an die CLI von codex oder claude, sobald Sie sie freigegeben haben.',
    artAlt: 'Ein Diorama aus Knete: ASIST reicht einem Roboter Unterlagen',
    askHtml: 'Kannst du diese Unterlagen<br />zusammenfassen?',
    confirm: 'Diesen Job starten?',
    confirmMeta: 'Arbeitsverzeichnis ~/work/report · Nur lesen',
    cancel: 'Abbrechen',
    startJob: 'Job starten'
  },
  memory: {
    title: 'Gedächtnis',
    headline: 'Ein Agent führt Tagebuch und ordnet, was er sich merkt.',
    body: 'Jede Nacht um Mitternacht schreibt er aus den Gesprächen des Tages ein Tagebuch: über Sie und über seinen eigenen Tag. Das Gespräch am nächsten Tag knüpft an das an, was er sich gemerkt hat.',
    artAlt: 'Ein Diorama aus Knete: ASIST schläft nachts, sein Tagebuch im Arm',
    diaryDate: 'Tagebuch · Mittwoch, 23. September',
    diaryTitle: 'Der Tag, an dem wir gemeinsam den Angebotsentwurf überarbeitet haben',
    diaryBody: 'Am frühen Nachmittag wurde ich gebeten, den Angebotsentwurf vorzulesen. Mir fiel auf, dass der dritte Abschnitt dasselbe sagte wie der davor, und ich habe darauf hingewiesen.',
    noteHtml: 'Er erinnert sich<br />wirklich …'
  },
  start: {
    title: 'Legen wir los.',
    sub: 'ASIST auf Ihrem Computer.',
    download: 'Herunterladen',
    setup: 'Anleitung zur Einrichtung',
    mac: 'macOS 14 oder neuer · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: 'Los geht’s!',
    step1: 'Sie brauchen einen Mac mit Apple Silicon oder einen PC mit Windows 11 und einen API-Schlüssel für ein Gesprächsmodell.',
    step2: 'Auf dem Mac öffnen Sie die dmg-Datei und ziehen ASIST in den Ordner „Programme“. Unter Windows öffnen Sie das Installationsprogramm; warnt SmartScreen, wählen Sie, es trotzdem auszuführen.',
    step3: 'Wählen Sie bei der ersten Einrichtung Sprache, Modell, Stimme und Mikrofon, und schon können Sie lossprechen.'
  },
  footer: {
    analytics: 'Diese Website verwendet Google Analytics, das Cookies setzt, um Besuche zu zählen.',
    analyticsLink: 'Wie Google Daten verwendet'
  }
}
