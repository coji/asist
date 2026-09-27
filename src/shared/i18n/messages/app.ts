import { defineMessages } from '../message'

/**
 * Text that belongs to no screen: the tray menu, the notifications macOS shows, the dialogs shown when
 * starting or quitting fails, a failed check of the services, and the errors of reading and writing files
 * and of opening links that any feature can hit.
 */
export const app = defineMessages({
  storage: {
    jsonBroken: {
      'ja-JP': '{file} の内容が壊れていて読めません。ファイルは変更していません。',
      'en-US': "{file} is damaged and can't be read. The file was left as it is.",
      'fr-FR': "Le contenu de {file} est endommagé et illisible. Le fichier n'a pas été modifié.",
      'de-DE': '{file} ist beschädigt und lässt sich nicht lesen. Die Datei wurde so gelassen, wie sie ist.',
      'hi-IN': '{file} खराब है और पढ़ी नहीं जा सकती। फ़ाइल जैसी थी वैसी ही है।',
      'id-ID': '{file} rusak dan tidak bisa dibaca. Filenya dibiarkan apa adanya.',
      'it-IT': "Il contenuto di {file} è danneggiato e non si può leggere. Il file è stato lasciato com'è.",
      'ko-KR': '{file} 파일의 내용이 손상되어 읽을 수 없습니다. 파일은 바꾸지 않았습니다.',
      'pt-BR': '{file} está danificado e não pode ser lido. O arquivo ficou como estava.',
      'es-419': '{file} está dañado y no se puede leer. El archivo se dejó como estaba.',
      'es-ES': '{file} está dañado y no se puede leer. El archivo se ha dejado como está.'
    },
    projectDirMissing: {
      'ja-JP': 'フォルダが見つかりません: {path}',
      'en-US': 'The folder was not found: {path}',
      'fr-FR': 'Dossier introuvable : {path}',
      'de-DE': 'Der Ordner wurde nicht gefunden: {path}',
      'hi-IN': 'फ़ोल्डर नहीं मिला: {path}',
      'id-ID': 'Foldernya tidak ditemukan: {path}',
      'it-IT': 'La cartella non è stata trovata: {path}',
      'ko-KR': '폴더를 찾을 수 없습니다: {path}',
      'pt-BR': 'A pasta não foi encontrada: {path}',
      'es-419': 'No se encontró la carpeta: {path}',
      'es-ES': 'No se encuentra la carpeta: {path}'
    },
    versionInvalid: {
      'ja-JP': '{file} に書かれた形式の版({version})を読めません。ファイルは変更していません。',
      'en-US': "The format version in {file} ({version}) can't be read. The file was left as it is.",
      'fr-FR': "La version de format indiquée dans {file} ({version}) est illisible. Le fichier n'a pas été modifié.",
      'de-DE': 'Die Formatversion in {file} ({version}) lässt sich nicht lesen. Die Datei wurde so gelassen, wie sie ist.',
      'hi-IN': '{file} में लिखा फ़ॉर्मैट संस्करण ({version}) पढ़ा नहीं जा सकता। फ़ाइल जैसी थी वैसी ही है।',
      'id-ID': 'Versi format di {file} ({version}) tidak bisa dibaca. Filenya dibiarkan apa adanya.',
      'it-IT': "La versione di formato indicata in {file} ({version}) non si può leggere. Il file è stato lasciato com'è.",
      'ko-KR': '{file} 파일에 적힌 형식 버전({version})을 읽을 수 없습니다. 파일은 바꾸지 않았습니다.',
      'pt-BR': 'A versão de formato em {file} ({version}) não pode ser lida. O arquivo ficou como estava.',
      'es-419': 'La versión de formato de {file} ({version}) no se puede leer. El archivo se dejó como estaba.',
      'es-ES': 'La versión de formato de {file} ({version}) no se puede leer. El archivo se ha dejado como está.'
    },
    versionTooNew: {
      'ja-JP': '{file} は、このアプリより新しい ASIST が書いたファイルです(形式の版 {version}。このアプリが読めるのは版 {supported} まで)。ファイルは変更していません。新しい ASIST で開いてください。',
      'en-US': '{file} was written by a newer ASIST (format version {version}; this app reads up to version {supported}). The file was left as it is. Open it with the newer ASIST.',
      'fr-FR': "{file} a été écrit par une version plus récente d'ASIST (format {version} ; cette application lit jusqu'à la version {supported}). Le fichier n'a pas été modifié. Ouvrez-le avec la version plus récente d'ASIST.",
      'de-DE': '{file} wurde von einem neueren ASIST geschrieben (Formatversion {version}; diese App liest bis Version {supported}). Die Datei wurde so gelassen, wie sie ist. Öffnen Sie sie mit dem neueren ASIST.',
      'hi-IN': '{file} को ASIST के नए संस्करण ने लिखा है (फ़ॉर्मैट संस्करण {version}; यह ऐप संस्करण {supported} तक पढ़ता है)। फ़ाइल जैसी थी वैसी ही है। इसे ASIST के नए संस्करण से खोलें।',
      'id-ID': '{file} ditulis oleh ASIST yang lebih baru (versi format {version}; aplikasi ini membaca sampai versi {supported}). Filenya dibiarkan apa adanya. Buka dengan ASIST yang lebih baru.',
      'it-IT': "{file} è stato scritto da una versione più recente di ASIST (formato {version}; questa app legge fino alla versione {supported}). Il file è stato lasciato com'è. Aprilo con la versione più recente di ASIST.",
      'ko-KR': '{file} 파일은 이 앱보다 새로운 ASIST가 쓴 파일입니다(형식 버전 {version}, 이 앱은 버전 {supported}까지 읽을 수 있습니다). 파일은 바꾸지 않았습니다. 새로운 ASIST로 여십시오.',
      'pt-BR': '{file} foi gravado por um ASIST mais novo (versão de formato {version}; este app lê até a versão {supported}). O arquivo ficou como estava. Abra-o com o ASIST mais novo.',
      'es-419': '{file} lo escribió un ASIST más reciente (versión de formato {version}; esta app lee hasta la versión {supported}). El archivo se dejó como estaba. Ábrelo con el ASIST más reciente.',
      'es-ES': '{file} lo ha escrito un ASIST más reciente (versión de formato {version}; esta app lee hasta la versión {supported}). El archivo se ha dejado como está. Ábrelo con el ASIST más reciente.'
    },
    upgradeMissing: {
      'ja-JP': '{file} の形式の版 {version} を今の形式に移す方法がありません。ファイルは変更していません。',
      'en-US': "{file} is in format version {version}, which this app can't convert to the current format. The file was left as it is.",
      'fr-FR': "{file} est au format {version}, que cette application ne sait pas convertir au format actuel. Le fichier n'a pas été modifié.",
      'de-DE': '{file} hat die Formatversion {version}, die diese App nicht in das aktuelle Format umwandeln kann. Die Datei wurde so gelassen, wie sie ist.',
      'hi-IN': '{file} फ़ॉर्मैट संस्करण {version} में है, जिसे यह ऐप मौजूदा फ़ॉर्मैट में नहीं बदल सकता। फ़ाइल जैसी थी वैसी ही है।',
      'id-ID': '{file} memakai versi format {version}, yang tidak bisa diubah aplikasi ini ke format sekarang. Filenya dibiarkan apa adanya.',
      'it-IT': "{file} è nel formato {version}, che questa app non sa convertire nel formato attuale. Il file è stato lasciato com'è.",
      'ko-KR': '{file} 파일은 형식 버전 {version}이며, 이 앱은 이를 현재 형식으로 옮길 수 없습니다. 파일은 바꾸지 않았습니다.',
      'pt-BR': '{file} está na versão de formato {version}, que este app não consegue converter para o formato atual. O arquivo ficou como estava.',
      'es-419': '{file} está en la versión de formato {version}, que esta app no puede convertir al formato actual. El archivo se dejó como estaba.',
      'es-ES': '{file} está en la versión de formato {version}, que esta app no puede convertir al formato actual. El archivo se ha dejado como está.'
    },
    projectPathNotAbsolute: {
      'ja-JP': 'フォルダのフルパスではありません: {path}',
      'en-US': 'This is not the full path of a folder: {path}',
      'fr-FR': "Ce n'est pas le chemin complet d'un dossier : {path}",
      'de-DE': 'Das ist kein vollständiger Ordnerpfad: {path}',
      'hi-IN': 'यह किसी फ़ोल्डर का पूरा पाथ नहीं है: {path}',
      'id-ID': 'Ini bukan path lengkap sebuah folder: {path}',
      'it-IT': 'Non è il percorso completo di una cartella: {path}',
      'ko-KR': '폴더의 전체 경로가 아닙니다: {path}',
      'pt-BR': 'Este não é o caminho completo de uma pasta: {path}',
      'es-419': 'No es la ruta completa de una carpeta: {path}',
      'es-ES': 'No es la ruta completa de una carpeta: {path}'
    }
  },
  tray: {
    show: {
      'ja-JP': 'ASIST を表示',
      'en-US': 'Show ASIST',
      'fr-FR': 'Afficher ASIST',
      'de-DE': 'ASIST zeigen',
      'hi-IN': 'ASIST दिखाएँ',
      'id-ID': 'Tampilkan ASIST',
      'it-IT': 'Mostra ASIST',
      'ko-KR': 'ASIST 표시',
      'pt-BR': 'Mostrar o ASIST',
      'es-419': 'Mostrar ASIST',
      'es-ES': 'Mostrar ASIST'
    },
    toggleMic: {
      'ja-JP': 'マイクを切り替える',
      'en-US': 'Toggle the microphone',
      'fr-FR': 'Activer ou désactiver le microphone',
      'de-DE': 'Mikrofon umschalten',
      'hi-IN': 'माइक्रोफ़ोन चालू/बंद करें',
      'id-ID': 'Nyalakan atau matikan mikrofon',
      'it-IT': 'Attiva o disattiva il microfono',
      'ko-KR': '마이크 켜고 끄기',
      'pt-BR': 'Ativar ou desativar o microfone',
      'es-419': 'Activar o desactivar el micrófono',
      'es-ES': 'Activar o desactivar el micrófono'
    },
    quit: {
      'ja-JP': '終了',
      'en-US': 'Quit',
      'fr-FR': 'Quitter',
      'de-DE': 'Beenden',
      'hi-IN': 'ASIST बंद करें',
      'id-ID': 'Keluar',
      'it-IT': 'Esci',
      'ko-KR': '종료',
      'pt-BR': 'Encerrar',
      'es-419': 'Salir',
      'es-ES': 'Salir'
    }
  },
  notify: {
    jobDone: {
      'ja-JP': 'ジョブが終わりました',
      'en-US': 'The job is done',
      'fr-FR': 'Le job est terminé',
      'de-DE': 'Der Job ist fertig',
      'hi-IN': 'जॉब पूरी हुई',
      'id-ID': 'Pekerjaannya selesai',
      'it-IT': "L'incarico è terminato",
      'ko-KR': '작업이 끝났습니다',
      'pt-BR': 'O job terminou',
      'es-419': 'El trabajo terminó',
      'es-ES': 'El trabajo ha terminado'
    },
    jobFailed: {
      'ja-JP': 'ジョブが失敗しました',
      'en-US': 'The job failed',
      'fr-FR': 'Le job a échoué',
      'de-DE': 'Der Job ist fehlgeschlagen',
      'hi-IN': 'जॉब पूरी नहीं हो सकी',
      'id-ID': 'Pekerjaannya gagal',
      'it-IT': "L'incarico non è riuscito",
      'ko-KR': '작업이 실패했습니다',
      'pt-BR': 'O job falhou',
      'es-419': 'El trabajo falló',
      'es-ES': 'El trabajo ha fallado'
    },
    unsupported: {
      'ja-JP': 'このコンピュータでは通知を出せません。',
      'en-US': "This computer can't show notifications.",
      'fr-FR': 'Cet ordinateur ne peut pas afficher de notification.',
      'de-DE': 'Dieser Computer kann keine Mitteilungen anzeigen.',
      'hi-IN': 'यह कंप्यूटर सूचनाएँ नहीं दिखा सकता।',
      'id-ID': 'Komputer ini tidak bisa menampilkan notifikasi.',
      'it-IT': 'Questo computer non può mostrare notifiche.',
      'ko-KR': '이 컴퓨터에서는 알림을 표시할 수 없습니다.',
      'pt-BR': 'Este computador não pode exibir notificações.',
      'es-419': 'Esta computadora no puede mostrar notificaciones.',
      'es-ES': 'Este ordenador no puede mostrar notificaciones.'
    }
  },
  startup: {
    launchFailed: {
      'ja-JP': 'ASIST を起動できませんでした',
      'en-US': "Couldn't start ASIST",
      'fr-FR': 'Impossible de démarrer ASIST',
      'de-DE': 'ASIST konnte nicht gestartet werden',
      'hi-IN': 'ASIST शुरू नहीं हो सका',
      'id-ID': 'Tidak bisa menjalankan ASIST',
      'it-IT': 'Impossibile avviare ASIST',
      'ko-KR': 'ASIST를 시작하지 못했습니다',
      'pt-BR': 'Não foi possível iniciar o ASIST',
      'es-419': 'No se pudo iniciar ASIST',
      'es-ES': 'No se ha podido iniciar ASIST'
    },
    agentStopFailed: {
      'ja-JP': 'Agent を停止できませんでした',
      'en-US': "Couldn't stop the agents",
      'fr-FR': "Impossible d'arrêter les agents",
      'de-DE': 'Die Agenten ließen sich nicht stoppen',
      'hi-IN': 'Agent रोके नहीं जा सके',
      'id-ID': 'Tidak bisa menghentikan agent',
      'it-IT': 'Impossibile fermare gli agenti',
      'ko-KR': 'Agent를 중지하지 못했습니다',
      'pt-BR': 'Não foi possível parar os agentes',
      'es-419': 'No se pudieron detener los agentes',
      'es-ES': 'No se han podido detener los agentes'
    },
    envUnreadable: {
      'ja-JP': '環境設定のファイルを読めません: {file}({detail})',
      'en-US': "Couldn't read the environment file {file} ({detail})",
      'fr-FR': "Impossible de lire le fichier d'environnement {file} ({detail})",
      'de-DE': 'Die Datei mit den Umgebungsvariablen {file} ließ sich nicht lesen ({detail})',
      'hi-IN': 'एनवायरनमेंट फ़ाइल {file} पढ़ी नहीं जा सकी ({detail})',
      'id-ID': 'Tidak bisa membaca file environment {file} ({detail})',
      'it-IT': 'Impossibile leggere il file di ambiente {file} ({detail})',
      'ko-KR': '환경 설정 파일을 읽을 수 없습니다: {file}({detail})',
      'pt-BR': 'Não foi possível ler o arquivo de ambiente {file} ({detail})',
      'es-419': 'No se pudo leer el archivo de entorno {file} ({detail})',
      'es-ES': 'No se puede leer el archivo de entorno {file} ({detail})'
    },
    untrustedPage: {
      'ja-JP': 'ASIST 以外のページからの操作を拒否しました: {url}',
      'en-US': 'Refused a request from a page that is not ASIST: {url}',
      'fr-FR': "Requête refusée depuis une page qui n'est pas ASIST : {url}",
      'de-DE': 'Anfrage von einer Seite abgelehnt, die nicht zu ASIST gehört: {url}',
      'hi-IN': 'ऐसे पेज से आया अनुरोध अस्वीकार किया गया जो ASIST नहीं है: {url}',
      'id-ID': 'Permintaan dari halaman selain ASIST ditolak: {url}',
      'it-IT': 'Richiesta rifiutata da una pagina che non è ASIST: {url}',
      'ko-KR': 'ASIST가 아닌 페이지의 요청을 거부했습니다: {url}',
      'pt-BR': 'Solicitação recusada de uma página que não é o ASIST: {url}',
      'es-419': 'Se rechazó una solicitud de una página que no es ASIST: {url}',
      'es-ES': 'Se ha rechazado una solicitud de una página que no es ASIST: {url}'
    },
    unsupportedPlatform: {
      'ja-JP': '{platform} の {arch} では ASIST は動きません。',
      'en-US': 'ASIST does not run on {platform} on {arch}.',
      'fr-FR': 'ASIST ne fonctionne pas sous {platform} sur {arch}.',
      'de-DE': 'ASIST läuft nicht unter {platform} auf {arch}.',
      'hi-IN': 'ASIST {arch} पर {platform} में नहीं चलता।',
      'id-ID': 'ASIST tidak berjalan di {platform} pada {arch}.',
      'it-IT': 'ASIST non funziona su {platform} con {arch}.',
      'ko-KR': 'ASIST는 {arch}의 {platform}에서 실행되지 않습니다.',
      'pt-BR': 'O ASIST não funciona no {platform} em {arch}.',
      'es-419': 'ASIST no funciona en {platform} con {arch}.',
      'es-ES': 'ASIST no funciona en {platform} con {arch}.'
    },
    calendarBackendUnknown: {
      'ja-JP': '{variable} の値 {value} は使えません。指定できるのは google だけです。',
      'en-US': "{variable} can't be {value}. The only value it takes is google.",
      'fr-FR': '{variable} ne peut pas valoir {value}. La seule valeur acceptée est google.',
      'de-DE': '{variable} kann nicht {value} sein. Der einzige mögliche Wert ist google.',
      'hi-IN': '{variable} का मान {value} नहीं हो सकता। सिर्फ़ google दिया जा सकता है।',
      'id-ID': '{variable} tidak bisa bernilai {value}. Satu-satunya nilai yang diterima adalah google.',
      'it-IT': "{variable} non può valere {value}. L'unico valore accettato è google.",
      'ko-KR': '{variable}의 값으로 {value}는 쓸 수 없습니다. 지정할 수 있는 값은 google뿐입니다.',
      'pt-BR': '{variable} não pode ser {value}. O único valor aceito é google.',
      'es-419': '{variable} no puede ser {value}. El único valor que acepta es google.',
      'es-ES': '{variable} no puede ser {value}. El único valor que acepta es google.'
    },
    googleClientMissing: {
      'ja-JP': '{variable}=google ですが、Google の OAuth クライアントがありません。ASIST_GOOGLE_CLIENT_ID と ASIST_GOOGLE_CLIENT_SECRET を .env かビルドの環境に書いてください。',
      'en-US': "{variable}=google is set, but there is no Google OAuth client. Put ASIST_GOOGLE_CLIENT_ID and ASIST_GOOGLE_CLIENT_SECRET in .env or in the build's environment.",
      'fr-FR': "{variable}=google est défini, mais il n'y a pas de client OAuth Google. Placez ASIST_GOOGLE_CLIENT_ID et ASIST_GOOGLE_CLIENT_SECRET dans .env ou dans l'environnement de la compilation.",
      'de-DE': '{variable}=google ist gesetzt, aber es gibt keinen OAuth-Client von Google. Tragen Sie ASIST_GOOGLE_CLIENT_ID und ASIST_GOOGLE_CLIENT_SECRET in .env oder in die Umgebung des Builds ein.',
      'hi-IN': '{variable}=google सेट है, पर Google का OAuth क्लाइंट नहीं है। ASIST_GOOGLE_CLIENT_ID और ASIST_GOOGLE_CLIENT_SECRET को .env या बिल्ड के एनवायरनमेंट में डालें।',
      'id-ID': '{variable}=google sudah diatur, tetapi klien OAuth Google tidak ada. Tulis ASIST_GOOGLE_CLIENT_ID dan ASIST_GOOGLE_CLIENT_SECRET di .env atau di lingkungan build.',
      'it-IT': "{variable}=google è impostato, ma manca il client OAuth di Google. Inserisci ASIST_GOOGLE_CLIENT_ID e ASIST_GOOGLE_CLIENT_SECRET in .env o nell'ambiente della build.",
      'ko-KR': '{variable}=google로 지정했지만 Google OAuth 클라이언트가 없습니다. ASIST_GOOGLE_CLIENT_ID와 ASIST_GOOGLE_CLIENT_SECRET을 .env나 빌드 환경에 적으십시오.',
      'pt-BR': '{variable}=google está definido, mas não há cliente OAuth do Google. Coloque ASIST_GOOGLE_CLIENT_ID e ASIST_GOOGLE_CLIENT_SECRET no .env ou no ambiente do build.',
      'es-419': '{variable}=google está definido, pero no hay cliente OAuth de Google. Pon ASIST_GOOGLE_CLIENT_ID y ASIST_GOOGLE_CLIENT_SECRET en .env o en el entorno de la compilación.',
      'es-ES': '{variable}=google está definido, pero no hay cliente OAuth de Google. Pon ASIST_GOOGLE_CLIENT_ID y ASIST_GOOGLE_CLIENT_SECRET en .env o en el entorno de la compilación.'
    }
  },
  status: {
    checkFailed: {
      'ja-JP': 'サービスの状態を確認できませんでした',
      'en-US': "Couldn't check the services",
      'fr-FR': 'Impossible de vérifier les services',
      'de-DE': 'Die Dienste ließen sich nicht prüfen',
      'hi-IN': 'सेवाओं की स्थिति देखी नहीं जा सकी',
      'id-ID': 'Tidak bisa memeriksa layanan',
      'it-IT': 'Impossibile controllare i servizi',
      'ko-KR': '서비스 상태를 확인하지 못했습니다',
      'pt-BR': 'Não foi possível verificar os serviços',
      'es-419': 'No se pudieron verificar los servicios',
      'es-ES': 'No se han podido comprobar los servicios'
    }
  },
  links: {
    refused: {
      'ja-JP': '開けるのは Web ページとメールアドレスのリンクだけです: {url}',
      'en-US': 'Only links to web pages and email addresses can be opened: {url}',
      'fr-FR': "Seuls les liens vers des pages web et des adresses e-mail peuvent s'ouvrir : {url}",
      'de-DE': 'Nur Links zu Webseiten und E-Mail-Adressen lassen sich öffnen: {url}',
      'hi-IN': 'सिर्फ़ वेब पेज और ईमेल पते वाले लिंक खोले जा सकते हैं: {url}',
      'id-ID': 'Hanya tautan ke halaman web dan alamat email yang bisa dibuka: {url}',
      'it-IT': 'Si possono aprire solo i link a pagine web e indirizzi email: {url}',
      'ko-KR': '웹 페이지와 이메일 주소 링크만 열 수 있습니다: {url}',
      'pt-BR': 'Só é possível abrir links de páginas da web e de endereços de e-mail: {url}',
      'es-419': 'Solo se pueden abrir enlaces a páginas web y direcciones de correo: {url}',
      'es-ES': 'Solo se pueden abrir enlaces a páginas web y direcciones de correo: {url}'
    },
    openFailed: {
      'ja-JP': 'リンクを開けませんでした',
      'en-US': "Couldn't open the link",
      'fr-FR': "Impossible d'ouvrir le lien",
      'de-DE': 'Der Link ließ sich nicht öffnen',
      'hi-IN': 'लिंक खोला नहीं जा सका',
      'id-ID': 'Tidak bisa membuka tautan',
      'it-IT': 'Impossibile aprire il link',
      'ko-KR': '링크를 열지 못했습니다',
      'pt-BR': 'Não foi possível abrir o link',
      'es-419': 'No se pudo abrir el enlace',
      'es-ES': 'No se ha podido abrir el enlace'
    }
  }
})
