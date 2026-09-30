import { defineMessages } from '../message'

export const settingsLanguage = defineMessages({
  lead: {
    'ja-JP': '画面の言語、話す言葉、天気やニュースの対象にする国を、それぞれ選べます。',
    'en-US': 'Choose the language of the screen, the language you speak and the country for weather and news, each on its own.',
    'fr-FR': "Choisissez séparément la langue de l'écran, la langue parlée et le pays de la météo et des actualités.",
    'de-DE': 'Wählen Sie die Sprache der Oberfläche, die gesprochene Sprache und das Land für Wetter und Nachrichten jeweils einzeln.',
    'hi-IN': 'स्क्रीन की भाषा, बोलने की भाषा और मौसम व खबरों का देश अलग-अलग चुनें।',
    'id-ID': 'Pilih bahasa layar, bahasa yang Anda ucapkan, dan negara untuk cuaca serta berita secara terpisah.',
    'it-IT': 'Scegli separatamente la lingua dello schermo, la lingua parlata e il paese di meteo e notizie.',
    'ko-KR': '화면 언어, 말하는 언어, 날씨와 뉴스의 대상 국가를 각각 고릅니다.',
    'pt-BR': 'Escolha separadamente o idioma da tela, o idioma falado e o país do clima e das notícias.',
    'es-419': 'Elige por separado el idioma de la pantalla, el idioma que hablas y el país del clima y las noticias.',
    'es-ES': 'Elige por separado el idioma de la pantalla, el idioma que hablas y el país del tiempo y las noticias.'
  },
  ui: {
    'ja-JP': '表示言語',
    'en-US': 'Interface language',
    'fr-FR': "Langue de l'interface",
    'de-DE': 'Anzeigesprache',
    'hi-IN': 'इंटरफ़ेस की भाषा',
    'id-ID': 'Bahasa antarmuka',
    'it-IT': "Lingua dell'interfaccia",
    'ko-KR': '표시 언어',
    'pt-BR': 'Idioma da interface',
    'es-419': 'Idioma de la interfaz',
    'es-ES': 'Idioma de la interfaz'
  },
  uiHint: {
    'ja-JP': '画面に出る文とエラーの言語です。',
    'en-US': 'The language of the text and errors on the screen.',
    'fr-FR': "La langue des textes et des erreurs à l'écran.",
    'de-DE': 'Die Sprache der Texte und Fehlermeldungen auf dem Bildschirm.',
    'hi-IN': 'स्क्रीन पर दिखने वाले पाठ और त्रुटियों की भाषा।',
    'id-ID': 'Bahasa teks dan pesan galat di layar.',
    'it-IT': 'La lingua dei testi e degli errori sullo schermo.',
    'ko-KR': '화면에 나오는 글과 오류의 언어입니다.',
    'pt-BR': 'O idioma dos textos e erros na tela.',
    'es-419': 'El idioma de los textos y errores de la pantalla.',
    'es-ES': 'El idioma de los textos y errores de la pantalla.'
  },
  conversation: {
    'ja-JP': '会話の言語',
    'en-US': 'Conversation language',
    'fr-FR': 'Langue de la conversation',
    'de-DE': 'Gesprächssprache',
    'hi-IN': 'बातचीत की भाषा',
    'id-ID': 'Bahasa percakapan',
    'it-IT': 'Lingua della conversazione',
    'ko-KR': '대화의 언어',
    'pt-BR': 'Idioma da conversa',
    'es-419': 'Idioma de la conversación',
    'es-ES': 'Idioma de la conversación'
  },
  conversationHint: {
    'ja-JP': '相槌とターンテイキングは日本語だけで動きます。選べる読み上げも言語で変わります。',
    'en-US': 'Backchannels and turn-taking work in Japanese only. The speech engines on offer change with the language.',
    'fr-FR': "Les acquiescements et la gestion des tours de parole n'existent qu'en japonais. Les moteurs de synthèse proposés changent selon la langue.",
    'de-DE': 'Hörersignale und die Sprecherwechsel-Erkennung gibt es nur auf Japanisch. Die angebotenen Sprachausgaben ändern sich mit der Sprache.',
    'hi-IN': 'हुँकारे और बोलने की बारी का अनुमान सिर्फ़ जापानी में चलते हैं। जो स्पीच इंजन मिलते हैं, वे भी भाषा के साथ बदलते हैं।',
    'id-ID': 'Tanggapan singkat dan pengaturan giliran bicara hanya jalan dalam bahasa Jepang. Mesin pembaca yang ditawarkan juga berubah mengikuti bahasa.',
    'it-IT': "I segnali di ascolto e la gestione dei turni esistono solo in giapponese. Anche i motori di lettura offerti cambiano con la lingua.",
    'ko-KR': '맞장구와 턴테이킹은 일본어에서만 작동합니다. 고를 수 있는 읽어주기 엔진도 언어에 따라 달라집니다.',
    'pt-BR': 'As interjeições de apoio e a troca de turno funcionam só em japonês. Os motores de leitura oferecidos também mudam com o idioma.',
    'es-419': 'Las muletillas de escucha y los turnos de habla funcionan solo en japonés. Los motores de lectura disponibles también cambian con el idioma.',
    'es-ES': 'Las muletillas de escucha y los turnos de habla funcionan solo en japonés. Los motores de lectura disponibles también cambian con el idioma.'
  },
  region: {
    'ja-JP': '地域',
    'en-US': 'Region',
    'fr-FR': 'Région',
    'de-DE': 'Region',
    'hi-IN': 'क्षेत्र',
    'id-ID': 'Wilayah',
    'it-IT': 'Regione',
    'ko-KR': '지역',
    'pt-BR': 'Região',
    'es-419': 'Región',
    'es-ES': 'Región'
  },
  regionHint: {
    'ja-JP': '天気とニュースの対象になり、日付や数値の書き方も合わせます。',
    'en-US': 'It decides where weather and news come from, and how dates and numbers are written.',
    'fr-FR': "Elle détermine la provenance de la météo et des actualités, ainsi que l'écriture des dates et des nombres.",
    'de-DE': 'Sie bestimmt, woher Wetter und Nachrichten kommen und wie Datum und Zahlen geschrieben werden.',
    'hi-IN': 'इससे तय होता है कि मौसम और खबरें कहाँ की हों, और तारीख़ तथा संख्याएँ किस तरह लिखी जाएँ।',
    'id-ID': 'Ini menentukan asal cuaca dan berita, serta cara penulisan tanggal dan angka.',
    'it-IT': 'Stabilisce da dove arrivano meteo e notizie e come si scrivono date e numeri.',
    'ko-KR': '날씨와 뉴스의 대상이 되고, 날짜와 숫자의 표기도 여기에 맞춥니다.',
    'pt-BR': 'Ela define de onde vêm o tempo e as notícias, e como datas e números são escritos.',
    'es-419': 'Define de dónde vienen el clima y las noticias, y cómo se escriben las fechas y los números.',
    'es-ES': 'Define de dónde vienen el tiempo y las noticias, y cómo se escriben las fechas y los números.'
  }
})
