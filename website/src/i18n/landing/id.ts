import type { LandingText } from './ja'

export const id: LandingText = {
  meta: {
    title: 'ASIST — cukup bicara, jadwal dan email pun beres.',
    description: 'ASIST adalah asisten realtime untuk Mac dan Windows. Cukup bicara, dan ASIST membantu pekerjaan Anda. Cuaca, acara, dan email muncul sebagai kartu di samping percakapan, dan pekerjaan yang makan waktu bisa diserahkan ke Agent.',
    ogDescription: 'Asisten realtime untuk Mac dan Windows. Cukup bicara, dan ASIST membantu pekerjaan Anda.'
  },
  nav: {
    label: 'Di halaman ini',
    footerLabel: 'Footer',
    home: 'Layar utama',
    cards: 'Kartu',
    apps: 'Aplikasi mini',
    agent: 'Agent',
    memory: 'Ingatan',
    start: 'Mulai',
    docs: 'Dokumentasi',
    github: 'Lihat di GitHub',
    language: 'Bahasa'
  },
  hero: {
    titleHtml: 'Cukup bicara,<br />jadwal dan email<br />pun beres.',
    leadHtml: 'ASIST adalah <span class="nw">asisten realtime</span> <span class="nw">untuk Mac dan Windows.</span><br />Cukup bicara, dan ASIST membantu pekerjaan Anda.',
    start: 'Mulai',
    platforms: 'macOS 14 atau lebih baru · Windows 11',
    free: 'Gratis dan open source',
    artAlt: 'Diorama tanah liat: ASIST di meja menghadap Mac, dengan robot di sebelahnya',
    youHtml: 'Hai ASIST,<br />ada apa saja hari ini?',
    meHtml: 'Ini jadwal<br />hari ini',
    cardAlt: 'Kartu berisi acara hari ini'
  },
  home: {
    title: 'Layar utama',
    headline: 'Percakapan dan kartu, dalam satu layar.',
    body: 'Bicaralah di tengah, dan kartu berisi jawabannya berjajar di kiri dan kanan. Dock di bawah membuka aplikasi mini.',
    shotAlt: 'Layar utama ASIST: percakapan di tengah, kartu kurs mata uang di kiri, kartu cuaca di kanan, dan Dock di bawah',
    card: 'Kartu',
    talk: 'Percakapan',
    apps: 'Aplikasi mini'
  },
  cards: {
    title: 'Kartu',
    headline: 'Yang Anda perlukan, langsung tersedia.',
    body: 'Sambil menjawab dengan suara, ASIST menampilkan cuaca, kalender, draf email, to-do, kurs mata uang, berita, peta, timer, dan lainnya sebagai kartu di samping percakapan.',
    label: 'Contoh kartu',
    weather: 'Kartu cuaca',
    map: 'Kartu peta',
    calendar: 'Kartu acara',
    fx: 'Kartu kurs mata uang',
    mailDraft: 'Kartu draf email',
    todo: 'Kartu to-do',
    timer: 'Kartu timer',
    note: '“Besok cuacanya bagaimana?”'
  },
  apps: {
    title: 'Aplikasi mini',
    headline: 'Mudah dipakai.',
    body: 'Buka pekerjaan Agent, tugas, catatan, email, ingatan, dan kalender langsung dari aplikasi mini, atau lewat percakapan: “Buka minggu depan di kalender.”',
    agent: 'Agent',
    tasks: 'Tugas',
    notes: 'Catatan',
    mail: 'Email',
    memory: 'Ingatan',
    calendar: 'Kalender',
    settings: 'Pengaturan'
  },
  agent: {
    title: 'Agent',
    headline: 'Serahkan pekerjaan yang merepotkan.',
    body: 'Riset dan pengeditan file yang makan waktu diserahkan ke CLI codex atau claude, setelah Anda menyetujuinya.',
    artAlt: 'Diorama tanah liat: ASIST menyerahkan berkas kepada robot',
    askHtml: 'Tolong rangkum<br />dokumen ini, ya?',
    confirm: 'Mulai pekerjaan ini?',
    confirmMeta: 'Lokasi kerja ~/work/report · Hanya baca',
    cancel: 'Batal',
    startJob: 'Mulai pekerjaan'
  },
  memory: {
    title: 'Ingatan',
    headline: 'Agent menulis jurnal dan merapikan ingatannya.',
    body: 'Setiap tengah malam, ASIST menulis jurnal dari percakapan hari itu: tentang Anda, dan tentang harinya sendiri. Percakapan keesokan harinya berlanjut dari apa yang ia ingat.',
    artAlt: 'Diorama tanah liat: ASIST tertidur di malam hari sambil memeluk jurnalnya',
    diaryDate: 'Jurnal · Rabu, 23 September',
    diaryTitle: 'Jangan lupa bawa payung',
    diaryBody: 'Sepertinya minggu depan ada perjalanan dinas ke Nagano. Aku ditanya soal cuaca, jadi kubilang akan hujan. Nanti pasti lupa, jadi sehari sebelumnya akan kuingatkan lagi.',
    noteHtml: 'Ternyata dia<br />benar-benar ingat…'
  },
  start: {
    title: 'Ayo mulai.',
    sub: 'ASIST, di komputer Anda.',
    downloadMac: 'Unduh untuk Mac',
    downloadWindows: 'Unduh untuk Windows',
    setup: 'Panduan penyiapan',
    mac: 'macOS 14 atau lebih baru · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: 'Ayo!',
    step1: 'Siapkan Mac dengan Apple Silicon atau PC dengan Windows 11, dan kunci API untuk satu model percakapan.',
    step2: 'Di Mac, buka dmg lalu seret ASIST ke folder Aplikasi. Di Windows, buka penginstal; jika SmartScreen menampilkan peringatan, pilih untuk tetap menjalankannya.',
    step3: 'Pilih bahasa, model, suara, dan mikrofon di penyiapan awal, lalu mulailah berbicara.'
  },
  footer: {
    privacy: 'Kebijakan Privasi',
    analytics: 'Situs ini memakai Google Analytics, yang memasang cookie, untuk menghitung kunjungan.',
    analyticsLink: 'Cara Google menggunakan data'
  }
}
