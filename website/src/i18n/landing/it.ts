import type { LandingText } from './ja'

export const it: LandingText = {
  meta: {
    title: 'ASIST — basta parlare, e impegni e mail sono sistemati.',
    description: 'ASIST è un assistente in tempo reale per Mac e Windows. Basta parlare e ti aiuta nel tuo lavoro. Meteo, impegni e mail compaiono come schede accanto alla conversazione, e i lavori che richiedono tempo passano a un agente.',
    ogDescription: 'Un assistente in tempo reale per Mac e Windows. Basta parlare e ti aiuta nel tuo lavoro.'
  },
  nav: {
    label: 'In questa pagina',
    footerLabel: 'Piè di pagina',
    home: 'Schermata principale',
    cards: 'Schede',
    apps: 'Mini app',
    agent: 'Agent',
    memory: 'Memoria',
    start: 'Inizia',
    docs: 'Documentazione',
    github: 'Vedi su GitHub',
    language: 'Lingua'
  },
  hero: {
    titleHtml: 'Basta parlare,<br />e impegni e mail<br />sono sistemati.',
    leadHtml: 'ASIST è un <span class="nw">assistente in tempo reale</span> <span class="nw">per Mac e Windows.</span><br />Basta parlare e ti aiuta nel tuo lavoro.',
    start: 'Inizia',
    platforms: 'macOS 14 o successivo · Windows 11',
    free: 'Gratuito e open source',
    artAlt: 'Un diorama in plastilina: ASIST alla scrivania davanti a un Mac, con un robot accanto',
    youHtml: 'Ehi ASIST,<br />cosa c’è oggi?',
    meHtml: 'Ecco la tua<br />giornata',
    cardAlt: 'Una scheda con gli impegni di oggi'
  },
  home: {
    title: 'Schermata principale',
    headline: 'Conversazione e schede in un’unica schermata.',
    body: 'Parli al centro, e le schede con le risposte si dispongono ai lati. Dal Dock in basso apri le mini app.',
    shotAlt: 'La schermata principale di ASIST: la conversazione al centro, una scheda dei tassi di cambio a sinistra, una scheda meteo a destra e il Dock in basso',
    card: 'Scheda',
    talk: 'Conversazione',
    apps: 'Mini app'
  },
  cards: {
    title: 'Schede',
    headline: 'Quello che ti serve, subito.',
    body: 'Meteo, calendario, bozze di mail, cose da fare, tassi di cambio, notizie, mappe, timer e altro ancora compaiono come schede accanto alla conversazione, mentre ASIST risponde a voce.',
    label: 'Esempi di schede',
    weather: 'Una scheda meteo',
    map: 'Una scheda con una mappa',
    calendar: 'Una scheda con gli impegni',
    fx: 'Una scheda dei tassi di cambio',
    mailDraft: 'Una scheda con una bozza di mail',
    todo: 'Una scheda delle cose da fare',
    timer: 'Una scheda del timer',
    note: '«Che tempo fa domani?»'
  },
  apps: {
    title: 'Mini app',
    headline: 'Facili da usare.',
    body: 'Apri gli incarichi dell’Agent, le attività, le note, la mail, la memoria e il calendario direttamente dalle mini app, oppure dalla conversazione: «Aprimi la settimana prossima nel calendario».',
    agent: 'Agent',
    tasks: 'Attività',
    notes: 'Note',
    mail: 'Mail',
    memory: 'Memoria',
    calendar: 'Calendario',
    settings: 'Impostazioni'
  },
  agent: {
    title: 'Agent',
    headline: 'Il lavoro noioso lascialo a lui.',
    body: 'Le ricerche e le modifiche ai file che richiedono tempo passano alla CLI di codex o di claude, dopo la tua approvazione.',
    artAlt: 'Un diorama in plastilina: ASIST porge dei documenti a un robot',
    askHtml: 'Mi riassumi<br />questi documenti?',
    confirm: 'Avviare questo incarico?',
    confirmMeta: 'Cartella di lavoro ~/work/report · Sola lettura',
    cancel: 'Annulla',
    startJob: "Avvia l'incarico"
  },
  memory: {
    title: 'Memoria',
    headline: 'Un agente tiene un diario e riordina i suoi ricordi.',
    body: 'Ogni notte a mezzanotte scrive un diario a partire dalle conversazioni della giornata: su di te e sulla sua giornata. Il giorno dopo, la conversazione riparte da ciò che ricorda.',
    artAlt: 'Un diorama in plastilina: ASIST che dorme di notte, stringendo il suo diario',
    diaryDate: 'Diario · mercoledì 23 settembre',
    diaryTitle: 'Il giorno in cui abbiamo sistemato insieme la bozza della proposta',
    diaryBody: 'Nel primo pomeriggio mi hanno chiesto di leggere ad alta voce la bozza della proposta. Ho notato che la terza sezione diceva la stessa cosa di quella precedente, e l’ho fatto presente.',
    noteHtml: 'Se lo ricorda<br />davvero…'
  },
  start: {
    title: 'Cominciamo.',
    sub: 'ASIST, sul tuo computer.',
    download: 'Scarica',
    setup: 'Guida alla configurazione',
    mac: 'macOS 14 o successivo · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: 'Andiamo!',
    step1: 'Procurati un Mac con Apple Silicon o un PC con Windows 11, e una chiave API per un modello di conversazione.',
    step2: 'Su Mac, apri il dmg e trascina ASIST in Applicazioni. Su Windows, apri il programma di installazione; se SmartScreen mostra un avviso, scegli di eseguirlo comunque.',
    step3: 'Nella configurazione iniziale scegli lingua, modello, voce e microfono, e inizia a parlare.'
  },
  footer: {
    privacy: 'Informativa sulla privacy',
    analytics: 'Questo sito usa Google Analytics, che imposta dei cookie, per contare le visite.',
    analyticsLink: 'Come Google usa i dati'
  }
}
