import { defineMessages } from '../message'

/**
 * What the microphone and the voice services report to the user while a conversation is running, and the
 * errors of the microphone, the live engines and speech output. Speech recognition's are in speech-recognition.ts.
 */
export const voice = defineMessages({
  micFailed: {
    'ja-JP': 'マイクを使えません',
    'en-US': "Can't use the microphone",
    'fr-FR': "Impossible d'utiliser le microphone",
    'de-DE': 'Das Mikrofon lässt sich nicht verwenden',
    'hi-IN': 'माइक्रोफ़ोन इस्तेमाल नहीं हो सका',
    'id-ID': 'Mikrofon tidak bisa dipakai',
    'it-IT': 'Impossibile usare il microfono',
    'ko-KR': '마이크를 사용할 수 없습니다',
    'pt-BR': 'Não é possível usar o microfone',
    'es-419': 'No se puede usar el micrófono',
    'es-ES': 'No se puede usar el micrófono'
  },
  micLiveFailed: {
    'ja-JP': 'マイクを使えません(live)',
    'en-US': "Can't use the microphone (live)",
    'fr-FR': "Impossible d'utiliser le microphone (live)",
    'de-DE': 'Das Mikrofon lässt sich nicht verwenden (live)',
    'hi-IN': 'माइक्रोफ़ोन इस्तेमाल नहीं हो सका (live)',
    'id-ID': 'Mikrofon tidak bisa dipakai (live)',
    'it-IT': 'Impossibile usare il microfono (live)',
    'ko-KR': '마이크를 사용할 수 없습니다(live)',
    'pt-BR': 'Não é possível usar o microfone (live)',
    'es-419': 'No se puede usar el micrófono (live)',
    'es-ES': 'No se puede usar el micrófono (live)'
  },
  liveFailed: {
    'ja-JP': 'live エンジンのエラー',
    'en-US': 'Live engine error',
    'fr-FR': 'Erreur du moteur live',
    'de-DE': 'Fehler der live-Engine',
    'hi-IN': 'live इंजन की एरर',
    'id-ID': 'Kesalahan mesin live',
    'it-IT': 'Errore del motore live',
    'ko-KR': 'live 엔진 오류',
    'pt-BR': 'Erro no motor live',
    'es-419': 'Error del motor live',
    'es-ES': 'Error del motor live'
  },
  engineChanged: {
    title: {
      'ja-JP': '声のエンジンの設定を変えました',
      'en-US': 'Voice engine settings changed',
      'fr-FR': 'Réglages du moteur vocal modifiés',
      'de-DE': 'Einstellungen der Sprach-Engine geändert',
      'hi-IN': 'वॉइस इंजन की सेटिंग बदल दी',
      'id-ID': 'Pengaturan mesin suara diubah',
      'it-IT': 'Impostazioni del motore vocale cambiate',
      'ko-KR': '음성 엔진 설정을 변경했습니다',
      'pt-BR': 'Configurações do motor de voz alteradas',
      'es-419': 'Se cambió la configuración del motor de voz',
      'es-ES': 'Has cambiado la configuración del motor de voz'
    },
    body: {
      'ja-JP': 'マイクをオンにし直すと新しい設定で話せます。',
      'en-US': 'Turn the microphone on again to speak with the new settings.',
      'fr-FR': 'Réactivez le microphone pour parler avec les nouveaux réglages.',
      'de-DE': 'Schalten Sie das Mikrofon wieder ein, um mit den neuen Einstellungen zu sprechen.',
      'hi-IN': 'नई सेटिंग से बात करने के लिए माइक्रोफ़ोन फिर से चालू करें।',
      'id-ID': 'Nyalakan lagi mikrofon untuk berbicara dengan pengaturan yang baru.',
      'it-IT': 'Riattiva il microfono per parlare con le nuove impostazioni.',
      'ko-KR': '마이크를 다시 켜면 새 설정으로 말할 수 있습니다.',
      'pt-BR': 'Ative o microfone de novo para falar com as novas configurações.',
      'es-419': 'Vuelve a activar el micrófono para hablar con la configuración nueva.',
      'es-ES': 'Vuelve a activar el micrófono para hablar con la nueva configuración.'
    }
  },
  services: {
    title: {
      'ja-JP': '音声サービス',
      'en-US': 'Voice services',
      'fr-FR': 'Services vocaux',
      'de-DE': 'Sprachdienste',
      'hi-IN': 'वॉइस सेवाएँ',
      'id-ID': 'Layanan suara',
      'it-IT': 'Servizi vocali',
      'ko-KR': '음성 서비스',
      'pt-BR': 'Serviços de voz',
      'es-419': 'Servicios de voz',
      'es-ES': 'Servicios de voz'
    },
    recognitionBack: {
      'ja-JP': '音声認識が戻りました',
      'en-US': 'Speech recognition is back',
      'fr-FR': 'La reconnaissance vocale est revenue',
      'de-DE': 'Die Spracherkennung läuft wieder',
      'hi-IN': 'स्पीच रिकग्निशन फिर चालू हुआ',
      'id-ID': 'Pengenalan suara kembali jalan',
      'it-IT': 'Il riconoscimento vocale è tornato attivo',
      'ko-KR': '음성 인식이 돌아왔습니다',
      'pt-BR': 'O reconhecimento de fala voltou',
      'es-419': 'El reconocimiento de voz volvió a funcionar',
      'es-ES': 'El reconocimiento de voz ha vuelto'
    },
    recognitionStopped: {
      'ja-JP': '音声認識が止まりました',
      'en-US': 'Speech recognition stopped',
      'fr-FR': "La reconnaissance vocale s'est arrêtée",
      'de-DE': 'Die Spracherkennung läuft nicht mehr',
      'hi-IN': 'स्पीच रिकग्निशन रुक गया',
      'id-ID': 'Pengenalan suara berhenti',
      'it-IT': 'Il riconoscimento vocale si è fermato',
      'ko-KR': '음성 인식이 멈췄습니다',
      'pt-BR': 'O reconhecimento de fala parou',
      'es-419': 'El reconocimiento de voz se detuvo',
      'es-ES': 'El reconocimiento de voz se ha detenido'
    },
    speechBack: {
      'ja-JP': '読み上げが戻りました',
      'en-US': 'Speech is back',
      'fr-FR': 'La synthèse vocale est revenue',
      'de-DE': 'Die Sprachausgabe läuft wieder',
      'hi-IN': 'स्पीच फिर चालू हुई',
      'id-ID': 'Pembacaan kembali jalan',
      'it-IT': 'La lettura ad alta voce è tornata attiva',
      'ko-KR': '읽어주기가 돌아왔습니다',
      'pt-BR': 'A leitura em voz alta voltou',
      'es-419': 'La lectura en voz alta volvió a funcionar',
      'es-ES': 'La lectura en voz alta ha vuelto'
    },
    speechStopped: {
      'ja-JP': '読み上げが止まりました',
      'en-US': 'Speech stopped',
      'fr-FR': "La synthèse vocale s'est arrêtée",
      'de-DE': 'Die Sprachausgabe läuft nicht mehr',
      'hi-IN': 'स्पीच रुक गई',
      'id-ID': 'Pembacaan berhenti',
      'it-IT': 'La lettura ad alta voce si è fermata',
      'ko-KR': '읽어주기가 멈췄습니다',
      'pt-BR': 'A leitura em voz alta parou',
      'es-419': 'La lectura en voz alta se detuvo',
      'es-ES': 'La lectura en voz alta se ha detenido'
    }
  },
  speech: {
    speakersFailed: {
      'ja-JP': '{engine} の話者を取得できませんでした(HTTP {status})。',
      'en-US': "Couldn't get the speakers of {engine} (HTTP {status}).",
      'fr-FR': "Impossible d'obtenir les locuteurs de {engine} (HTTP {status}).",
      'de-DE': 'Die Sprecher von {engine} ließen sich nicht abrufen (HTTP {status}).',
      'hi-IN': '{engine} के स्पीकर नहीं मिल सके (HTTP {status})।',
      'id-ID': 'Tidak bisa mengambil daftar pembicara {engine} (HTTP {status}).',
      'it-IT': 'Impossibile ottenere i parlanti di {engine} (HTTP {status}).',
      'ko-KR': '{engine}의 화자를 가져오지 못했습니다(HTTP {status}).',
      'pt-BR': 'Não foi possível obter os locutores de {engine} (HTTP {status}).',
      'es-419': 'No se pudieron obtener los locutores de {engine} (HTTP {status}).',
      'es-ES': 'No se han podido obtener los locutores de {engine} (HTTP {status}).'
    },
    cannotSpeak: {
      'ja-JP': '{engine} は {language} を読み上げられません。',
      'en-US': "{engine} can't speak {language}.",
      'fr-FR': '{engine} ne parle pas {language}.',
      'de-DE': '{engine} spricht kein {language}.',
      'hi-IN': '{engine} {language} नहीं बोल सकता।',
      'id-ID': '{engine} tidak bisa berbicara dalam {language}.',
      'it-IT': '{engine} non parla {language}.',
      'ko-KR': '{engine}에서는 {language} 음성을 읽어줄 수 없습니다.',
      'pt-BR': '{engine} não fala {language}.',
      'es-419': '{engine} no habla {language}.',
      'es-ES': '{engine} no habla {language}.'
    },
    noSpeech: {
      'ja-JP': '「読み上げなし」を選んでいるので、音声を作りません。',
      'en-US': 'No speech is selected, so no audio is produced.',
      'fr-FR': "« Sans synthèse vocale » est sélectionné : aucun audio n'est produit.",
      'de-DE': '„Keine Sprachausgabe“ ist gewählt, deshalb entsteht kein Ton.',
      'hi-IN': '"कोई स्पीच नहीं" चुना है, इसलिए कोई ऑडियो नहीं बनेगा।',
      'id-ID': 'Karena pilihannya Tanpa pembacaan, tidak ada audio yang dibuat.',
      'it-IT': 'È selezionato «Nessuna lettura», quindi non viene prodotto audio.',
      'ko-KR': "'읽어주기 없음'을 선택했으므로 음성을 만들지 않습니다.",
      'pt-BR': '“Sem leitura” está selecionado, então nenhum áudio é gerado.',
      'es-419': 'Está elegido «Sin lectura en voz alta», así que no se genera audio.',
      'es-ES': 'Está elegido “Sin lectura en voz alta”, así que no se genera audio.'
    },
    systemUnavailable: {
      macos: {
        'ja-JP': 'この Mac では macOS の音声合成を使えません。設定の「声」でほかの読み上げを選んでください。',
        'en-US': "This Mac can't use the macOS voice. Choose another speech engine on the Voice page in Settings.",
        'fr-FR': 'Ce Mac ne peut pas utiliser la voix de macOS. Choisissez un autre moteur de synthèse vocale sur la page Voix des réglages.',
        'de-DE': 'Dieser Mac kann die macOS-Stimme nicht verwenden. Wählen Sie auf der Seite „Stimme“ in den Einstellungen eine andere Engine für die Sprachausgabe.',
        'hi-IN': 'इस Mac पर macOS की आवाज़ इस्तेमाल नहीं हो सकती। सेटिंग्ज़ के "आवाज़" पेज पर कोई दूसरा स्पीच इंजन चुनें।',
        'id-ID': 'Mac ini tidak bisa memakai suara macOS. Pilih mesin pembacaan lain di halaman Suara pada Pengaturan.',
        'it-IT': 'Questo Mac non può usare la sintesi vocale di macOS. Scegli un altro motore per la lettura nella pagina «Voce» delle impostazioni.',
        'ko-KR': "이 Mac에서는 macOS 음성 합성을 사용할 수 없습니다. 설정의 '음성'에서 다른 읽어주기를 선택하십시오.",
        'pt-BR': 'Este Mac não pode usar a voz do macOS. Escolha outro motor de leitura na página Voz dos ajustes.',
        'es-419': 'Esta Mac no puede usar la voz de macOS. Elige otro motor de lectura en voz alta en la página Voz de Configuración.',
        'es-ES': 'Este Mac no puede usar la voz de macOS. Elige otro motor de lectura en la página “Voz” de Ajustes.'
      },
      windows: {
        'ja-JP': 'このコンピュータでは Windows の音声合成を使えません。設定の「声」でほかの読み上げを選んでください。',
        'en-US': "This computer can't use the Windows voice. Choose another speech engine on the Voice page in Settings.",
        'fr-FR': 'Cet ordinateur ne peut pas utiliser la voix de Windows. Choisissez un autre moteur de synthèse vocale sur la page Voix des réglages.',
        'de-DE': 'Dieser Computer kann die Windows-Stimme nicht verwenden. Wählen Sie auf der Seite „Stimme“ in den Einstellungen eine andere Engine für die Sprachausgabe.',
        'hi-IN': 'इस कंप्यूटर पर Windows की आवाज़ इस्तेमाल नहीं हो सकती। सेटिंग्ज़ के "आवाज़" पेज पर कोई दूसरा स्पीच इंजन चुनें।',
        'id-ID': 'Komputer ini tidak bisa memakai suara Windows. Pilih mesin pembacaan lain di halaman Suara pada Pengaturan.',
        'it-IT': 'Questo computer non può usare la sintesi vocale di Windows. Scegli un altro motore per la lettura nella pagina «Voce» delle impostazioni.',
        'ko-KR': "이 컴퓨터에서는 Windows 음성 합성을 사용할 수 없습니다. 설정의 '음성'에서 다른 읽어주기를 선택하십시오.",
        'pt-BR': 'Este computador não pode usar a voz do Windows. Escolha outro motor de leitura na página Voz dos ajustes.',
        'es-419': 'Esta computadora no puede usar la voz de Windows. Elige otro motor de lectura en voz alta en la página Voz de Configuración.',
        'es-ES': 'Este ordenador no puede usar la voz de Windows. Elige otro motor de lectura en la página “Voz” de Ajustes.'
      }
    },
    cannotRunHere: {
      'ja-JP': '{engine} は、この OS では動きません。',
      'en-US': "{engine} doesn't run on this OS.",
      'fr-FR': "{engine} ne fonctionne pas sur ce système d'exploitation.",
      'de-DE': '{engine} läuft unter diesem Betriebssystem nicht.',
      'hi-IN': '{engine} इस ऑपरेटिंग सिस्टम पर नहीं चलता।',
      'id-ID': '{engine} tidak berjalan di sistem operasi ini.',
      'it-IT': '{engine} non funziona su questo sistema operativo.',
      'ko-KR': '이 OS에서는 {engine} 엔진이 실행되지 않습니다.',
      'pt-BR': '{engine} não funciona neste sistema operacional.',
      'es-419': '{engine} no funciona en este sistema operativo.',
      'es-ES': '{engine} no funciona en este sistema operativo.'
    },
    engineFailed: {
      'ja-JP': '{engine} で読み上げられませんでした({detail})。',
      'en-US': "{engine} couldn't read aloud ({detail}).",
      'fr-FR': "{engine} n'a pas pu lire le texte à voix haute ({detail}).",
      'de-DE': '{engine} konnte den Text nicht vorlesen ({detail}).',
      'hi-IN': '{engine} से पढ़कर सुनाया नहीं जा सका ({detail})।',
      'id-ID': '{engine} tidak bisa membacakan teksnya ({detail}).',
      'it-IT': '{engine} non è riuscito a leggere il testo ad alta voce ({detail}).',
      'ko-KR': '{engine}에서 읽어주지 못했습니다({detail}).',
      'pt-BR': '{engine} não conseguiu ler o texto em voz alta ({detail}).',
      'es-419': '{engine} no pudo leer el texto en voz alta ({detail}).',
      'es-ES': '{engine} no ha podido leer el texto en voz alta ({detail}).'
    },
    engineStopped: {
      'ja-JP': '{engine} の読み上げを止めました。',
      'en-US': 'Stopped reading aloud with {engine}.',
      'fr-FR': 'La lecture à voix haute avec {engine} a été arrêtée.',
      'de-DE': 'Das Vorlesen mit {engine} wurde beendet.',
      'hi-IN': '{engine} से पढ़कर सुनाना रोक दिया गया।',
      'id-ID': 'Pembacaan dengan {engine} dihentikan.',
      'it-IT': 'La lettura ad alta voce con {engine} è stata interrotta.',
      'ko-KR': '{engine}의 읽어주기를 멈췄습니다.',
      'pt-BR': 'A leitura em voz alta com {engine} foi interrompida.',
      'es-419': 'Se detuvo la lectura en voz alta con {engine}.',
      'es-ES': 'Se ha detenido la lectura en voz alta con {engine}.'
    },
    engineNoResponse: {
      'ja-JP': '{engine} が読み上げの途中で応答しなくなりました。',
      'en-US': '{engine} stopped responding while reading aloud.',
      'fr-FR': '{engine} a cessé de répondre pendant la lecture à voix haute.',
      'de-DE': '{engine} reagierte beim Vorlesen nicht mehr.',
      'hi-IN': 'पढ़कर सुनाते समय {engine} ने जवाब देना बंद कर दिया।',
      'id-ID': '{engine} berhenti merespons saat membacakan teks.',
      'it-IT': '{engine} ha smesso di rispondere durante la lettura ad alta voce.',
      'ko-KR': '읽어주는 도중에 {engine}의 응답이 끊겼습니다.',
      'pt-BR': '{engine} parou de responder durante a leitura em voz alta.',
      'es-419': '{engine} dejó de responder durante la lectura en voz alta.',
      'es-ES': '{engine} ha dejado de responder durante la lectura en voz alta.'
    },
    engineFailedWithoutReason: {
      'ja-JP': '{engine} で読み上げられませんでした。',
      'en-US': "{engine} couldn't read aloud.",
      'fr-FR': "{engine} n'a pas pu lire le texte à voix haute.",
      'de-DE': '{engine} konnte den Text nicht vorlesen.',
      'hi-IN': '{engine} से पढ़कर सुनाया नहीं जा सका।',
      'id-ID': '{engine} tidak bisa membacakan teksnya.',
      'it-IT': '{engine} non è riuscito a leggere il testo ad alta voce.',
      'ko-KR': '{engine}에서 읽어주지 못했습니다.',
      'pt-BR': '{engine} não conseguiu ler o texto em voz alta.',
      'es-419': '{engine} no pudo leer el texto en voz alta.',
      'es-ES': '{engine} no ha podido leer el texto en voz alta.'
    }
  },
  live: {
    notLiveEngine: {
      'ja-JP': '声のエンジンが live ではありません。設定の「声」で live のエンジンを選んでください。',
      'en-US': 'The voice engine is not a live engine. Choose one on the Voice page in Settings.',
      'fr-FR': "Le moteur vocal n'est pas un moteur live. Choisissez-en un sur la page Voix des réglages.",
      'de-DE': 'Die Sprach-Engine ist keine live-Engine. Wählen Sie auf der Seite „Stimme“ in den Einstellungen eine aus.',
      'hi-IN': 'वॉइस इंजन live नहीं है। सेटिंग्ज़ के "आवाज़" पेज पर कोई live इंजन चुनें।',
      'id-ID': 'Mesin suaranya bukan mesin live. Pilih mesin live di halaman Suara pada Pengaturan.',
      'it-IT': 'Il motore vocale non è un motore live. Scegline uno nella pagina «Voce» delle impostazioni.',
      'ko-KR': "음성 엔진이 live가 아닙니다. 설정의 '음성'에서 live 엔진을 선택하십시오.",
      'pt-BR': 'O motor de voz não é um motor live. Escolha um na página Voz dos ajustes.',
      'es-419': 'El motor de voz no es un motor live. Elige uno en la página Voz de Configuración.',
      'es-ES': 'El motor de voz no es un motor live. Elige uno en la página “Voz” de Ajustes.'
    },
    notRunning: {
      'ja-JP': 'live エンジンが動いていません。マイクをオンにしてください。',
      'en-US': 'The live engine is not running. Turn the microphone on.',
      'fr-FR': 'Le moteur live ne tourne pas. Activez le microphone.',
      'de-DE': 'Die live-Engine läuft nicht. Schalten Sie das Mikrofon ein.',
      'hi-IN': 'live इंजन नहीं चल रहा। माइक्रोफ़ोन चालू करें।',
      'id-ID': 'Mesin live tidak berjalan. Nyalakan mikrofonnya.',
      'it-IT': 'Il motore live non è in funzione. Attiva il microfono.',
      'ko-KR': 'live 엔진이 동작하지 않습니다. 마이크를 켜십시오.',
      'pt-BR': 'O motor live não está em execução. Ative o microfone.',
      'es-419': 'El motor live no está en ejecución. Activa el micrófono.',
      'es-ES': 'El motor live no está en marcha. Activa el micrófono.'
    },
    openTimeout: {
      'ja-JP': '{engine} のセッションが時間内に開きませんでした。',
      'en-US': 'The {engine} session did not open in time.',
      'fr-FR': "La session {engine} ne s'est pas ouverte à temps.",
      'de-DE': 'Die Sitzung von {engine} hat sich nicht rechtzeitig geöffnet.',
      'hi-IN': '{engine} का सेशन समय पर नहीं खुला।',
      'id-ID': 'Sesi {engine} tidak terbuka tepat waktu.',
      'it-IT': 'La sessione di {engine} non si è aperta in tempo.',
      'ko-KR': '{engine} 세션이 제한 시간 안에 열리지 않았습니다.',
      'pt-BR': 'A sessão do {engine} não abriu a tempo.',
      'es-419': 'La sesión de {engine} no se abrió a tiempo.',
      'es-ES': 'La sesión de {engine} no se ha abierto a tiempo.'
    },
    closed: {
      'ja-JP': '{engine} の接続が閉じました({reason})',
      'en-US': 'The {engine} connection closed ({reason})',
      'fr-FR': "La connexion à {engine} s'est fermée ({reason})",
      'de-DE': 'Die Verbindung zu {engine} wurde geschlossen ({reason})',
      'hi-IN': '{engine} का कनेक्शन बंद हो गया ({reason})',
      'id-ID': 'Koneksi {engine} tertutup ({reason})',
      'it-IT': 'La connessione con {engine} si è chiusa ({reason})',
      'ko-KR': '{engine} 연결이 닫혔습니다({reason})',
      'pt-BR': 'A conexão do {engine} fechou ({reason})',
      'es-419': 'La conexión con {engine} se cerró ({reason})',
      'es-ES': 'La conexión de {engine} se ha cerrado ({reason})'
    },
    connectionError: {
      'ja-JP': '{engine} の接続でエラーが起きました',
      'en-US': 'The {engine} connection failed',
      'fr-FR': 'La connexion à {engine} a échoué',
      'de-DE': 'Die Verbindung zu {engine} ist fehlgeschlagen',
      'hi-IN': '{engine} का कनेक्शन विफल रहा',
      'id-ID': 'Koneksi {engine} gagal',
      'it-IT': 'La connessione con {engine} non è riuscita',
      'ko-KR': '{engine} 연결에서 오류가 일어났습니다',
      'pt-BR': 'A conexão do {engine} falhou',
      'es-419': 'Falló la conexión con {engine}',
      'es-ES': 'La conexión de {engine} ha fallado'
    },
    connectFailed: {
      'ja-JP': '接続できませんでした({detail})',
      'en-US': "Couldn't connect ({detail})",
      'fr-FR': 'Connexion impossible ({detail})',
      'de-DE': 'Die Verbindung kam nicht zustande ({detail})',
      'hi-IN': 'कनेक्ट नहीं हो सका ({detail})',
      'id-ID': 'Tidak bisa menyambung ({detail})',
      'it-IT': 'Impossibile connettersi ({detail})',
      'ko-KR': '연결하지 못했습니다({detail})',
      'pt-BR': 'Não foi possível conectar ({detail})',
      'es-419': 'No se pudo conectar ({detail})',
      'es-ES': 'No se ha podido conectar ({detail})'
    },
    startFailed: {
      'ja-JP': 'live エンジンを起動できませんでした。',
      'en-US': "Couldn't start the live engine.",
      'fr-FR': 'Impossible de démarrer le moteur live.',
      'de-DE': 'Die live-Engine konnte nicht gestartet werden.',
      'hi-IN': 'live इंजन शुरू नहीं हो सका।',
      'id-ID': 'Tidak bisa menjalankan mesin live.',
      'it-IT': 'Impossibile avviare il motore live.',
      'ko-KR': 'live 엔진을 시작하지 못했습니다.',
      'pt-BR': 'Não foi possível iniciar o motor live.',
      'es-419': 'No se pudo iniciar el motor live.',
      'es-ES': 'No se ha podido iniciar el motor live.'
    },
    textTooLong: {
      'ja-JP': '文が長すぎます。live エンジンに送れるのは {max} 文字までです。',
      'en-US': 'The text is too long. The live engine takes up to {max} characters.',
      'fr-FR': 'Le texte est trop long. Le moteur live accepte au plus {max} caractères.',
      'de-DE': 'Der Text ist zu lang. Die live-Engine nimmt höchstens {max} Zeichen an.',
      'hi-IN': 'टेक्स्ट बहुत लंबा है। live इंजन में ज़्यादा से ज़्यादा {max} अक्षर भेजे जा सकते हैं।',
      'id-ID': 'Teksnya terlalu panjang. Mesin live menerima paling banyak {max} karakter.',
      'it-IT': 'Il testo è troppo lungo. Il motore live accetta al massimo {max} caratteri.',
      'ko-KR': '텍스트가 너무 깁니다. live 엔진에는 최대 {max}자까지 보낼 수 있습니다.',
      'pt-BR': 'O texto é longo demais. O motor live aceita no máximo {max} caracteres.',
      'es-419': 'El texto es demasiado largo. El motor live acepta hasta {max} caracteres.',
      'es-ES': 'El texto es demasiado largo. El motor live acepta hasta {max} caracteres.'
    }
  },
  mic: {
    notPermitted: {
      macos: {
        'ja-JP': 'マイクを使えませんでした。システム設定で ASIST にマイクを許可してください。',
        'en-US': "Couldn't use the microphone. Allow ASIST to use it in System Settings.",
        'fr-FR': "Impossible d'utiliser le microphone. Autorisez ASIST à s'en servir dans Réglages Système.",
        'de-DE': 'Das Mikrofon konnte nicht verwendet werden. Erlauben Sie ASIST in den Systemeinstellungen den Zugriff darauf.',
        'hi-IN': 'माइक्रोफ़ोन इस्तेमाल नहीं हो सका। सिस्टम सेटिंग्ज़ में ASIST को माइक्रोफ़ोन की इजाज़त दें।',
        'id-ID': 'Mikrofon tidak bisa dipakai. Izinkan ASIST memakainya di Pengaturan Sistem.',
        'it-IT': "Impossibile usare il microfono. Consenti l'accesso ad ASIST in Impostazioni di Sistema.",
        'ko-KR': '마이크를 사용하지 못했습니다. 시스템 설정에서 ASIST에 마이크 사용을 허용하십시오.',
        'pt-BR': 'Não foi possível usar o microfone. Permita o acesso do ASIST nos Ajustes do Sistema.',
        'es-419': 'No se pudo usar el micrófono. Permite que ASIST lo use en Configuración del Sistema.',
        'es-ES': 'No se ha podido usar el micrófono. Permite que ASIST lo use en Ajustes del Sistema.'
      },
      windows: {
        'ja-JP': 'マイクを使えませんでした。Windows の設定でデスクトップ アプリにマイクを許可してください。',
        'en-US': "Couldn't use the microphone. Allow desktop apps to use it in Windows Settings.",
        'fr-FR': "Impossible d'utiliser le microphone. Autorisez les applications de bureau à s'en servir dans Paramètres Windows.",
        'de-DE': 'Das Mikrofon konnte nicht verwendet werden. Erlauben Sie Desktop-Apps in den Windows-Einstellungen den Zugriff darauf.',
        'hi-IN': 'माइक्रोफ़ोन इस्तेमाल नहीं हो सका। Windows सेटिंग्स में डेस्कटॉप ऐप्स को माइक्रोफ़ोन की इजाज़त दें।',
        'id-ID': 'Mikrofon tidak bisa dipakai. Izinkan aplikasi desktop memakainya di Pengaturan Windows.',
        'it-IT': 'Impossibile usare il microfono. Consenti alle app desktop di usarlo in Impostazioni di Windows.',
        'ko-KR': '마이크를 사용하지 못했습니다. Windows 설정에서 데스크톱 앱의 마이크 사용을 허용하십시오.',
        'pt-BR': 'Não foi possível usar o microfone. Permita que os aplicativos da área de trabalho o usem nas Configurações do Windows.',
        'es-419': 'No se pudo usar el micrófono. Permite que las apps de escritorio lo usen en Configuración de Windows.',
        'es-ES': 'No se ha podido usar el micrófono. Permite que las aplicaciones de escritorio lo usen en Configuración de Windows.'
      }
    },
    unsupported: {
      'ja-JP': 'このコンピュータではマイクを使えません。',
      'en-US': "This computer can't use a microphone.",
      'fr-FR': 'Cet ordinateur ne peut pas utiliser de microphone.',
      'de-DE': 'Dieser Computer kann kein Mikrofon verwenden.',
      'hi-IN': 'इस कंप्यूटर पर माइक्रोफ़ोन इस्तेमाल नहीं हो सकता।',
      'id-ID': 'Komputer ini tidak bisa memakai mikrofon.',
      'it-IT': 'Questo computer non può usare un microfono.',
      'ko-KR': '이 컴퓨터에서는 마이크를 사용할 수 없습니다.',
      'pt-BR': 'Este computador não pode usar um microfone.',
      'es-419': 'Esta computadora no puede usar un micrófono.',
      'es-ES': 'Este ordenador no puede usar un micrófono.'
    },
    noAudioTrack: {
      'ja-JP': 'マイクから音を受け取れませんでした。入力機器を確かめてください。',
      'en-US': "Couldn't capture audio from the microphone. Check the input device.",
      'fr-FR': "Impossible de capter le son du microphone. Vérifiez le périphérique d'entrée.",
      'de-DE': 'Vom Mikrofon kam kein Ton an. Prüfen Sie das Eingabegerät.',
      'hi-IN': 'माइक्रोफ़ोन से आवाज़ नहीं मिली। इनपुट डिवाइस देखें।',
      'id-ID': 'Tidak bisa menangkap suara dari mikrofon. Periksa perangkat masukannya.',
      'it-IT': "Impossibile acquisire l'audio dal microfono. Controlla il dispositivo di ingresso.",
      'ko-KR': '마이크에서 소리를 받지 못했습니다. 입력 기기를 확인하십시오.',
      'pt-BR': 'Não foi possível captar o áudio do microfone. Verifique o dispositivo de entrada.',
      'es-419': 'No se pudo captar el audio del micrófono. Revisa el dispositivo de entrada.',
      'es-ES': 'No se ha podido captar el sonido del micrófono. Comprueba el dispositivo de entrada.'
    }
  },
  maaiUnavailable: {
    title: {
      'ja-JP': 'MaAI を起動できませんでした',
      'en-US': "Couldn't start MaAI",
      'fr-FR': 'Impossible de démarrer MaAI',
      'de-DE': 'MaAI ließ sich nicht starten',
      'hi-IN': 'MaAI शुरू नहीं हो सका',
      'id-ID': 'Tidak bisa memulai MaAI',
      'it-IT': 'Impossibile avviare MaAI',
      'ko-KR': 'MaAI를 시작할 수 없습니다',
      'pt-BR': 'Não foi possível iniciar o MaAI',
      'es-419': 'No se pudo iniciar MaAI',
      'es-ES': 'No se ha podido iniciar MaAI'
    },
    body: {
      'ja-JP': '話し終わりは、設定した無音の長さで判断します。会話はこのまま続けられます。',
      'en-US': 'The end of speech is judged by the silence length in your settings. You can keep talking.',
      'fr-FR': 'La fin de la parole est déterminée par la durée de silence réglée. Vous pouvez continuer à parler.',
      'de-DE': 'Das Ende der Rede wird an der eingestellten Stille erkannt. Sie können weitersprechen.',
      'hi-IN': 'बोलना कब खत्म हुआ, यह सेटिंग में तय खामोशी की लंबाई से तय होगा। आप बात जारी रख सकते हैं।',
      'id-ID': 'Akhir ucapan ditentukan dari lama jeda hening di pengaturan. Percakapan bisa terus berjalan.',
      'it-IT': 'La fine del parlato viene decisa dalla durata del silenzio impostata. Puoi continuare a parlare.',
      'ko-KR': '말이 끝났는지는 설정한 무음 길이로 판단합니다. 대화는 그대로 계속할 수 있습니다.',
      'pt-BR': 'O fim da fala é decidido pela duração do silêncio definida nas configurações. Você pode continuar falando.',
      'es-419': 'El final del habla se decide por la duración del silencio configurada. Puedes seguir hablando.',
      'es-ES': 'El final del habla se decide por la duración del silencio configurada. Puedes seguir hablando.'
    }
  },
  maaiBehind: {
    title: {
      'ja-JP': 'MaAI の処理が遅れています',
      'en-US': 'MaAI is falling behind',
      'fr-FR': 'MaAI prend du retard',
      'de-DE': 'MaAI hängt hinterher',
      'hi-IN': 'MaAI पीछे चल रहा है',
      'id-ID': 'MaAI tertinggal',
      'it-IT': 'MaAI è in ritardo',
      'ko-KR': 'MaAI 처리가 늦어지고 있습니다',
      'pt-BR': 'O MaAI está atrasado',
      'es-419': 'MaAI se está atrasando',
      'es-ES': 'MaAI se está retrasando'
    },
    body: {
      'ja-JP': '追いつくまで、話し終わりは設定した無音の長さで判断します。会話はこのまま続けられます。',
      'en-US': 'Until it catches up, the end of speech is judged by the silence length in your settings. You can keep talking.',
      'fr-FR': "Tant qu'il n'a pas rattrapé son retard, la fin de la parole est déterminée par la durée de silence réglée. Vous pouvez continuer à parler.",
      'de-DE': 'Bis MaAI aufgeholt hat, wird das Ende der Rede an der eingestellten Stille erkannt. Sie können weitersprechen.',
      'hi-IN': 'जब तक MaAI बराबरी पर नहीं आ जाता, बोलना कब खत्म हुआ, यह सेटिंग में तय खामोशी की लंबाई से तय होगा। आप बात जारी रख सकते हैं।',
      'id-ID': 'Sampai MaAI menyusul, akhir ucapan ditentukan dari lama jeda hening di pengaturan. Percakapan bisa terus berjalan.',
      'it-IT': 'Finché non recupera, la fine del parlato viene decisa dalla durata del silenzio impostata. Puoi continuare a parlare.',
      'ko-KR': '따라잡을 때까지 말이 끝났는지는 설정한 무음 길이로 판단합니다. 대화는 그대로 계속할 수 있습니다.',
      'pt-BR': 'Até recuperar o atraso, o fim da fala é decidido pela duração do silêncio definida nas configurações. Você pode continuar falando.',
      'es-419': 'Hasta que se ponga al día, el final del habla se decide por la duración del silencio configurada. Puedes seguir hablando.',
      'es-ES': 'Hasta que se ponga al día, el final del habla se decide por la duración del silencio configurada. Puedes seguir hablando.'
    }
  }
})
