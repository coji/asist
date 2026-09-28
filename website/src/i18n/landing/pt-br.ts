import type { LandingText } from './ja'

export const ptBr: LandingText = {
  meta: {
    title: 'ASIST — é só falar, e sua agenda e seus e-mails se resolvem.',
    description: 'O ASIST é um assistente em tempo real para Mac e Windows. É só falar, e ele ajuda no seu trabalho. Previsão do tempo, eventos e e-mails aparecem como cartões ao lado da conversa, e o trabalho mais demorado fica com o Agent.',
    ogDescription: 'Um assistente em tempo real para Mac e Windows. É só falar, e ele ajuda no seu trabalho.'
  },
  nav: {
    label: 'Nesta página',
    footerLabel: 'Rodapé',
    home: 'Tela inicial',
    cards: 'Cartões',
    apps: 'Miniapps',
    agent: 'Agent',
    memory: 'Memória',
    start: 'Começar',
    docs: 'Documentação',
    github: 'Ver no GitHub',
    language: 'Idioma'
  },
  hero: {
    titleHtml: 'É só falar,<br />e sua agenda e seus e-mails<br />se resolvem.',
    leadHtml: 'O ASIST é um <span class="nw">assistente em tempo real</span> <span class="nw">para Mac e Windows.</span><br />É só falar, e ele ajuda no seu trabalho.',
    start: 'Começar',
    platforms: 'macOS 14 ou posterior · Windows 11',
    free: 'Gratuito e de código aberto',
    artAlt: 'Um diorama de argila: o ASIST numa mesa, de frente para um Mac, com um robô ao lado',
    youHtml: 'Oi, ASIST,<br />o que tem pra hoje?',
    meHtml: 'Aqui está<br />o seu dia',
    cardAlt: 'Um cartão com os eventos de hoje'
  },
  home: {
    title: 'Tela inicial',
    headline: 'A conversa e os cartões, numa só tela.',
    body: 'Fale no centro, e os cartões com as respostas se alinham dos dois lados. O Dock, embaixo, abre os miniapps.',
    shotAlt: 'A tela inicial do ASIST: a conversa no centro, um cartão de câmbio à esquerda, um cartão de previsão do tempo à direita e o Dock embaixo',
    card: 'Cartão',
    talk: 'Conversa',
    apps: 'Miniapps'
  },
  cards: {
    title: 'Cartões',
    headline: 'O que você precisa, na hora.',
    body: 'Previsão do tempo, calendário, rascunhos de e-mail, tarefas, câmbio, notícias, mapas, timers e muito mais aparecem como cartões ao lado da conversa enquanto o ASIST responde em voz alta.',
    label: 'Exemplos de cartões',
    weather: 'Um cartão de previsão do tempo',
    map: 'Um cartão de mapa',
    calendar: 'Um cartão de eventos',
    fx: 'Um cartão de câmbio',
    mailDraft: 'Um cartão de rascunho de e-mail',
    todo: 'Um cartão de tarefas',
    timer: 'Um cartão de timer',
    note: '“Como vai estar o tempo amanhã?”'
  },
  apps: {
    title: 'Miniapps',
    headline: 'Fácil de usar.',
    body: 'Abra os jobs do Agent, as tarefas, as notas, o e-mail, a memória e o calendário direto pelos miniapps, ou pela conversa: “Abra a próxima semana no calendário.”',
    agent: 'Agent',
    tasks: 'Tarefas',
    notes: 'Notas',
    mail: 'E-mail',
    memory: 'Memória',
    calendar: 'Calendário',
    settings: 'Ajustes'
  },
  agent: {
    title: 'Agent',
    headline: 'Delegue o trabalho chato.',
    body: 'Pesquisas e edições de arquivos que levam tempo vão para a CLI do codex ou do claude, depois que você aprova.',
    artAlt: 'Um diorama de argila: o ASIST entregando papéis a um robô',
    askHtml: 'Pode resumir<br />esses documentos?',
    confirm: 'Iniciar este job?',
    confirmMeta: 'Diretório de trabalho ~/work/report · Somente leitura',
    cancel: 'Cancelar',
    startJob: 'Iniciar job'
  },
  memory: {
    title: 'Memória',
    headline: 'O Agent escreve um diário e organiza o que lembra.',
    body: 'Toda noite, à meia-noite, ele escreve um diário com as conversas do dia: sobre você e sobre o próprio dia. A conversa do dia seguinte começa a partir do que ele lembra.',
    artAlt: 'Um diorama de argila: o ASIST dormindo à noite, abraçado ao diário',
    diaryDate: 'Diário · quarta-feira, 23 de setembro',
    diaryTitle: 'O dia em que corrigimos juntos o rascunho da proposta',
    diaryBody: 'No começo da tarde, me pediram para ler em voz alta o rascunho da proposta. Percebi que a terceira seção dizia o mesmo que a anterior e avisei.',
    noteHtml: 'Ele lembra<br />mesmo…'
  },
  start: {
    title: 'Vamos começar.',
    sub: 'O ASIST no seu computador.',
    downloadMac: 'Baixar para Mac',
    downloadWindows: 'Baixar para Windows',
    setup: 'Guia de configuração',
    mac: 'macOS 14 ou posterior · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: 'Vamos lá!',
    step1: 'Tenha um Mac com Apple Silicon ou um PC com Windows 11, e uma chave de API de um modelo de conversa.',
    step2: 'No Mac, abra o dmg e arraste o ASIST para a pasta Aplicativos. No Windows, abra o instalador; se o SmartScreen mostrar um aviso, escolha executar mesmo assim.',
    step3: 'Na configuração inicial, escolha o idioma, o modelo, a voz e o microfone, e comece a falar.'
  },
  footer: {
    privacy: 'Política de Privacidade',
    analytics: 'Este site usa o Google Analytics, que define cookies, para contar as visitas.',
    analyticsLink: 'Como o Google usa os dados'
  }
}
