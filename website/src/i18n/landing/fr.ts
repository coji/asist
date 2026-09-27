import type { LandingText } from './ja'

export const fr: LandingText = {
  meta: {
    title: 'ASIST — parlez-lui, il s’occupe de votre agenda et de vos mails.',
    description: 'ASIST est un assistant en temps réel pour Mac et Windows. Il suffit de lui parler pour qu’il vous aide dans votre travail. La météo, les rendez-vous et les mails s’affichent en cartes à côté de la conversation, et les tâches qui prennent du temps sont confiées à un agent.',
    ogDescription: 'Un assistant en temps réel pour Mac et Windows. Il suffit de lui parler pour qu’il vous aide dans votre travail.'
  },
  nav: {
    label: 'Sur cette page',
    footerLabel: 'Pied de page',
    home: 'Écran d’accueil',
    cards: 'Cartes',
    apps: 'Mini-apps',
    agent: 'Agent',
    memory: 'Mémoire',
    start: 'Commencer',
    docs: 'Documentation',
    github: 'Voir sur GitHub',
    language: 'Langue'
  },
  hero: {
    titleHtml: 'Parlez-lui,<br />il s’occupe de votre agenda<br />et de vos mails.',
    leadHtml: 'ASIST est un <span class="nw">assistant en temps réel</span> <span class="nw">pour Mac et Windows.</span><br />Parlez-lui, et il vous aide dans votre travail.',
    start: 'Commencer',
    platforms: 'macOS 14 ou plus récent · Windows 11',
    free: 'Gratuit et open source',
    artAlt: 'Un diorama en pâte à modeler : ASIST à son bureau devant un Mac, avec un robot à côté',
    youHtml: 'Dis, ASIST,<br />j’ai quoi aujourd’hui ?',
    meHtml: 'Voici votre<br />journée',
    cardAlt: 'Une carte avec les rendez-vous du jour'
  },
  home: {
    title: 'Écran d’accueil',
    headline: 'La conversation et les cartes, sur un seul écran.',
    body: 'Vous parlez au centre, et les cartes avec les réponses s’alignent de chaque côté. Le Dock, en bas, ouvre les mini-apps.',
    shotAlt: 'L’écran d’accueil d’ASIST : la conversation au centre, une carte de taux de change à gauche, une carte météo à droite et le Dock en bas',
    card: 'Carte',
    talk: 'Conversation',
    apps: 'Mini-apps'
  },
  cards: {
    title: 'Cartes',
    headline: 'L’essentiel, tout de suite.',
    body: 'Météo, calendrier, brouillons de mails, choses à faire, taux de change, actualités, plans, minuteurs et bien plus s’affichent en cartes à côté de la conversation pendant qu’ASIST vous répond à voix haute.',
    label: 'Exemples de cartes',
    weather: 'Une carte météo',
    map: 'Une carte avec un plan',
    calendar: 'Une carte de rendez-vous',
    fx: 'Une carte de taux de change',
    mailDraft: 'Une carte de brouillon de mail',
    todo: 'Une carte de choses à faire',
    timer: 'Une carte de minuteur',
    note: '« Quel temps fera-t-il demain ? »'
  },
  apps: {
    title: 'Mini-apps',
    headline: 'Simples à utiliser.',
    body: 'Ouvrez les jobs de l’Agent, les tâches, les notes, les mails, la mémoire et le calendrier directement depuis les mini-apps, ou depuis la conversation : « Ouvre la semaine prochaine dans le calendrier. »',
    agent: 'Agent',
    tasks: 'Tâches',
    notes: 'Notes',
    mail: 'Mail',
    memory: 'Mémoire',
    calendar: 'Calendrier',
    settings: 'Réglages'
  },
  agent: {
    title: 'Agent',
    headline: 'Confiez-lui les tâches fastidieuses.',
    body: 'Les recherches et les modifications de fichiers qui prennent du temps sont confiées au CLI codex ou claude, une fois que vous les avez approuvées.',
    artAlt: 'Un diorama en pâte à modeler : ASIST tend des documents à un robot',
    askHtml: 'Tu peux me résumer<br />ces documents ?',
    confirm: 'Lancer ce job ?',
    confirmMeta: 'Dossier de travail ~/work/report · Lecture seule',
    cancel: 'Annuler',
    startJob: 'Lancer le job'
  },
  memory: {
    title: 'Mémoire',
    headline: 'Un agent tient un journal et range ses souvenirs.',
    body: 'Chaque nuit à minuit, il écrit son journal à partir des conversations du jour : sur vous, et sur sa propre journée. Le lendemain, la conversation repart de ce dont il se souvient.',
    artAlt: 'Un diorama en pâte à modeler : ASIST endormi la nuit, son journal dans les bras',
    diaryDate: 'Journal · mercredi 23 septembre',
    diaryTitle: 'Le jour où nous avons corrigé ensemble le brouillon de la proposition',
    diaryBody: 'En début d’après-midi, on m’a demandé de lire à voix haute le brouillon de la proposition. J’ai remarqué que la troisième partie disait la même chose que la précédente, et je l’ai signalé.',
    noteHtml: 'Il se souvient<br />vraiment…'
  },
  start: {
    title: 'Lancez-vous.',
    sub: 'ASIST, sur votre ordinateur.',
    download: 'Télécharger',
    setup: 'Guide d’installation',
    mac: 'macOS 14 ou plus récent · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: 'C’est parti !',
    step1: 'Munissez-vous d’un Mac Apple Silicon ou d’un PC sous Windows 11, et d’une clé API pour un modèle de conversation.',
    step2: 'Sur Mac, ouvrez le dmg et faites glisser ASIST dans Applications. Sur Windows, ouvrez le programme d’installation ; si SmartScreen affiche un avertissement, choisissez de l’exécuter quand même.',
    step3: 'Choisissez la langue, le modèle, la voix et le micro lors de la première configuration, puis commencez à parler.'
  },
  footer: {
    analytics: 'Ce site utilise Google Analytics, qui dépose des cookies, pour mesurer sa fréquentation.',
    analyticsLink: 'Comment Google utilise les données'
  }
}
