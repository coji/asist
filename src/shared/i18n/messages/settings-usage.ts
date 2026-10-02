import { defineMessages } from '../message'

/**
 * The costs page of the settings, and the errors of reading the usage record behind it. The model and
 * product names come from the catalogs and read the same in every language.
 */
export const settingsUsage = defineMessages({
  title: {
    'ja-JP': 'API の料金',
    'en-US': 'API costs',
    'fr-FR': 'Coût des API',
    'de-DE': 'API-Kosten',
    'hi-IN': 'API का ख़र्च',
    'id-ID': 'Biaya API',
    'it-IT': 'Costi delle API',
    'ko-KR': 'API 요금',
    'pt-BR': 'Custos de API',
    'es-419': 'Costos de API',
    'es-ES': 'Costes de API'
  },
  lead: {
    'ja-JP': 'ASIST が有料の API を使った分の、日ごとの料金です。',
    'en-US': 'What ASIST spent on paid APIs, day by day.',
    'fr-FR': 'Ce que ASIST a dépensé en API payantes, jour par jour.',
    'de-DE': 'Was ASIST für kostenpflichtige APIs ausgegeben hat, Tag für Tag.',
    'hi-IN': 'ASIST ने पेड API पर हर दिन कितना ख़र्च किया।',
    'id-ID': 'Biaya API berbayar yang dipakai ASIST, per hari.',
    'it-IT': 'Quanto ha speso ASIST in API a pagamento, giorno per giorno.',
    'ko-KR': 'ASIST가 유료 API를 사용한 날짜별 요금입니다.',
    'pt-BR': 'Quanto o ASIST gastou com APIs pagas, dia a dia.',
    'es-419': 'Lo que ASIST gastó en API de pago, día por día.',
    'es-ES': 'Lo que ASIST ha gastado en API de pago, día a día.'
  },
  disclaimer: {
    'ja-JP':
      '金額は、ASIST が数えた使用量と各社の公開価格(2026年9月23日時点)から計算した目安です。実際の請求額と一致することは保証できません。請求額は各社の管理画面で確認してください。',
    'en-US':
      "These amounts are estimates from the usage ASIST counted and each provider's list prices as of September 23, 2026. They are not guaranteed to match your bill. Check each provider's console for the amount you are charged.",
    'fr-FR':
      "Ces montants sont des estimations calculées à partir de l'utilisation comptée par ASIST et des prix publics de chaque fournisseur au 23 septembre 2026. Rien ne garantit qu'ils correspondent à votre facture. Consultez la console de chaque fournisseur pour le montant facturé.",
    'de-DE':
      'Die Beträge sind Schätzungen aus der von ASIST gezählten Nutzung und den Listenpreisen der Anbieter vom 23. September 2026. Sie stimmen nicht garantiert mit Ihrer Rechnung überein. Den berechneten Betrag sehen Sie in der Konsole des jeweiligen Anbieters.',
    'hi-IN':
      'ये रक़में ASIST के गिने गए इस्तेमाल और 23 सितंबर 2026 की हर प्रदाता की सार्वजनिक क़ीमतों से निकाला गया अनुमान हैं। इनका आपके बिल से मेल खाना तय नहीं है। असली रक़म हर प्रदाता के कंसोल में देखें।',
    'id-ID':
      'Jumlah ini adalah perkiraan dari pemakaian yang dihitung ASIST dan harga publik tiap penyedia per 23 September 2026. Tidak ada jaminan jumlahnya sama dengan tagihan Anda. Periksa tagihan sebenarnya di konsol tiap penyedia.',
    'it-IT':
      "Gli importi sono stime calcolate dall'uso contato da ASIST e dai prezzi di listino di ogni fornitore al 23 settembre 2026. Non è garantito che corrispondano alla fattura. Controlla l'importo addebitato nella console di ogni fornitore.",
    'ko-KR':
      '금액은 ASIST가 센 사용량과 각 회사의 공개 가격(2026년 9월 23일 기준)으로 계산한 추정치입니다. 실제 청구 금액과 같다고 보장할 수 없습니다. 청구 금액은 각 회사의 관리 화면에서 확인하십시오.',
    'pt-BR':
      'Os valores são estimativas feitas a partir do uso contado pelo ASIST e dos preços públicos de cada fornecedor em 23 de setembro de 2026. Não há garantia de que batam com a sua fatura. Confira o valor cobrado no console de cada fornecedor.',
    'es-419':
      'Los montos son estimaciones a partir del uso que contó ASIST y de los precios públicos de cada proveedor al 23 de septiembre de 2026. No se garantiza que coincidan con tu factura. Revisa el monto cobrado en la consola de cada proveedor.',
    'es-ES':
      'Los importes son estimaciones a partir del uso que ha contado ASIST y de los precios públicos de cada proveedor a 23 de septiembre de 2026. No se garantiza que coincidan con tu factura. Consulta el importe cobrado en la consola de cada proveedor.'
  },
  chartTitle: {
    'ja-JP': '日ごとの料金',
    'en-US': 'Cost per day',
    'fr-FR': 'Coût par jour',
    'de-DE': 'Kosten pro Tag',
    'hi-IN': 'हर दिन का ख़र्च',
    'id-ID': 'Biaya per hari',
    'it-IT': 'Costo al giorno',
    'ko-KR': '날짜별 요금',
    'pt-BR': 'Custo por dia',
    'es-419': 'Costo por día',
    'es-ES': 'Coste por día'
  },
  range: {
    'ja-JP': '期間',
    'en-US': 'Period',
    'fr-FR': 'Période',
    'de-DE': 'Zeitraum',
    'hi-IN': 'अवधि',
    'id-ID': 'Periode',
    'it-IT': 'Periodo',
    'ko-KR': '기간',
    'pt-BR': 'Período',
    'es-419': 'Periodo',
    'es-ES': 'Periodo'
  },
  lastDays: {
    'ja-JP': '過去 {days} 日',
    'en-US': 'Last {days} days',
    'fr-FR': '{days} derniers jours',
    'de-DE': 'Letzte {days} Tage',
    'hi-IN': 'पिछले {days} दिन',
    'id-ID': '{days} hari terakhir',
    'it-IT': 'Ultimi {days} giorni',
    'ko-KR': '최근 {days}일',
    'pt-BR': 'Últimos {days} dias',
    'es-419': 'Últimos {days} días',
    'es-ES': 'Últimos {days} días'
  },
  grouping: {
    'ja-JP': '内訳の分け方',
    'en-US': 'Split by',
    'fr-FR': 'Répartition',
    'de-DE': 'Aufteilung',
    'hi-IN': 'बँटवारा',
    'id-ID': 'Rincian menurut',
    'it-IT': 'Suddivisione',
    'ko-KR': '구분 기준',
    'pt-BR': 'Dividir por',
    'es-419': 'Dividir por',
    'es-ES': 'Dividir por'
  },
  groupings: {
    kind: {
      'ja-JP': '種類別',
      'en-US': 'By type',
      'fr-FR': 'Par type',
      'de-DE': 'Nach Art',
      'hi-IN': 'प्रकार के हिसाब से',
      'id-ID': 'Menurut jenis',
      'it-IT': 'Per tipo',
      'ko-KR': '종류별',
      'pt-BR': 'Por tipo',
      'es-419': 'Por tipo',
      'es-ES': 'Por tipo'
    },
    model: {
      'ja-JP': 'モデル別',
      'en-US': 'By model',
      'fr-FR': 'Par modèle',
      'de-DE': 'Nach Modell',
      'hi-IN': 'मॉडल के हिसाब से',
      'id-ID': 'Menurut model',
      'it-IT': 'Per modello',
      'ko-KR': '모델별',
      'pt-BR': 'Por modelo',
      'es-419': 'Por modelo',
      'es-ES': 'Por modelo'
    }
  },
  kinds: {
    llm: {
      'ja-JP': '会話モデル',
      'en-US': 'Conversation models',
      'fr-FR': 'Modèles de conversation',
      'de-DE': 'Gesprächsmodelle',
      'hi-IN': 'बातचीत के मॉडल',
      'id-ID': 'Model percakapan',
      'it-IT': 'Modelli di conversazione',
      'ko-KR': '대화 모델',
      'pt-BR': 'Modelos de conversa',
      'es-419': 'Modelos de conversación',
      'es-ES': 'Modelos de conversación'
    },
    live: {
      'ja-JP': 'Live の音声',
      'en-US': 'Live voice',
      'fr-FR': 'Voix Live',
      'de-DE': 'Live-Stimme',
      'hi-IN': 'Live आवाज़',
      'id-ID': 'Suara Live',
      'it-IT': 'Voce Live',
      'ko-KR': 'Live 음성',
      'pt-BR': 'Voz Live',
      'es-419': 'Voz Live',
      'es-ES': 'Voz Live'
    },
    agent: {
      'ja-JP': 'Agent',
      'en-US': 'Agent',
      'fr-FR': 'Agent',
      'de-DE': 'Agent',
      'hi-IN': 'Agent',
      'id-ID': 'Agent',
      'it-IT': 'Agent',
      'ko-KR': 'Agent',
      'pt-BR': 'Agent',
      'es-419': 'Agent',
      'es-ES': 'Agent'
    }
  },
  other: {
    'ja-JP': 'その他',
    'en-US': 'Other',
    'fr-FR': 'Autres',
    'de-DE': 'Sonstige',
    'hi-IN': 'अन्य',
    'id-ID': 'Lainnya',
    'it-IT': 'Altro',
    'ko-KR': '기타',
    'pt-BR': 'Outros',
    'es-419': 'Otros',
    'es-ES': 'Otros'
  },
  purposes: {
    conversation: {
      'ja-JP': '会話',
      'en-US': 'Conversation',
      'fr-FR': 'Conversation',
      'de-DE': 'Gespräch',
      'hi-IN': 'बातचीत',
      'id-ID': 'Percakapan',
      'it-IT': 'Conversazione',
      'ko-KR': '대화',
      'pt-BR': 'Conversa',
      'es-419': 'Conversación',
      'es-ES': 'Conversación'
    },
    bridge: {
      'ja-JP': 'つなぎの一言',
      'en-US': 'Bridge phrase',
      'fr-FR': 'Phrase de transition',
      'de-DE': 'Überbrückungssatz',
      'hi-IN': 'बीच का वाक्य',
      'id-ID': 'Kalimat jembatan',
      'it-IT': 'Frase ponte',
      'ko-KR': '연결 한마디',
      'pt-BR': 'Frase de ponte',
      'es-419': 'Frase puente',
      'es-ES': 'Frase puente'
    },
    summary: {
      'ja-JP': '会話の要約',
      'en-US': 'Conversation summary',
      'fr-FR': 'Résumé de la conversation',
      'de-DE': 'Gesprächszusammenfassung',
      'hi-IN': 'बातचीत का सार',
      'id-ID': 'Ringkasan percakapan',
      'it-IT': 'Riassunto della conversazione',
      'ko-KR': '대화 요약',
      'pt-BR': 'Resumo da conversa',
      'es-419': 'Resumen de la conversación',
      'es-ES': 'Resumen de la conversación'
    }
  },
  total: {
    'ja-JP': '{days} 日間の合計',
    'en-US': 'Total for {days} days',
    'fr-FR': 'Total sur {days} jours',
    'de-DE': 'Summe über {days} Tage',
    'hi-IN': '{days} दिनों का कुल',
    'id-ID': 'Total {days} hari',
    'it-IT': 'Totale di {days} giorni',
    'ko-KR': '{days}일 합계',
    'pt-BR': 'Total de {days} dias',
    'es-419': 'Total de {days} días',
    'es-ES': 'Total de {days} días'
  },
  today: {
    'ja-JP': '今日',
    'en-US': 'Today',
    'fr-FR': "Aujourd'hui",
    'de-DE': 'Heute',
    'hi-IN': 'आज',
    'id-ID': 'Hari ini',
    'it-IT': 'Oggi',
    'ko-KR': '오늘',
    'pt-BR': 'Hoje',
    'es-419': 'Hoy',
    'es-ES': 'Hoy'
  },
  empty: {
    'ja-JP': 'この期間には有料の API を使っていません。会話や Agent のジョブで API を使うと、ここに日ごとの料金が並びます。',
    'en-US': 'No paid API was used in this period. Once a conversation or an Agent job uses one, the cost of each day appears here.',
    'fr-FR': "Aucune API payante n'a été utilisée sur cette période. Dès qu'une conversation ou une tâche Agent en utilise une, le coût de chaque jour s'affiche ici.",
    'de-DE': 'In diesem Zeitraum wurde keine kostenpflichtige API genutzt. Sobald ein Gespräch oder ein Agent-Job eine nutzt, stehen hier die Kosten jedes Tages.',
    'hi-IN': 'इस अवधि में कोई पेड API इस्तेमाल नहीं हुआ। बातचीत या Agent का काम API इस्तेमाल करेगा, तो यहाँ हर दिन का ख़र्च दिखेगा।',
    'id-ID': 'Tidak ada API berbayar yang dipakai pada periode ini. Setelah percakapan atau pekerjaan Agent memakainya, biaya tiap hari muncul di sini.',
    'it-IT': "In questo periodo non è stata usata nessuna API a pagamento. Quando una conversazione o un incarico Agent ne usa una, qui compare il costo di ogni giorno.",
    'ko-KR': '이 기간에는 유료 API를 사용하지 않았습니다. 대화나 Agent 작업에서 API를 사용하면 여기에 날짜별 요금이 표시됩니다.',
    'pt-BR': 'Nenhuma API paga foi usada neste período. Quando uma conversa ou um job do Agent usar uma, o custo de cada dia aparece aqui.',
    'es-419': 'No se usó ninguna API de pago en este periodo. Cuando una conversación o un trabajo de Agent use una, aquí aparecerá el costo de cada día.',
    'es-ES': 'No se ha usado ninguna API de pago en este periodo. Cuando una conversación o un trabajo de Agent use una, aquí aparecerá el coste de cada día.'
  },
  breakdownTitle: {
    'ja-JP': 'モデルと用途ごとの料金',
    'en-US': 'Cost by model and use',
    'fr-FR': 'Coût par modèle et par usage',
    'de-DE': 'Kosten nach Modell und Zweck',
    'hi-IN': 'मॉडल और काम के हिसाब से ख़र्च',
    'id-ID': 'Biaya menurut model dan kegunaan',
    'it-IT': 'Costo per modello e uso',
    'ko-KR': '모델과 용도별 요금',
    'pt-BR': 'Custo por modelo e uso',
    'es-419': 'Costo por modelo y uso',
    'es-ES': 'Coste por modelo y uso'
  },
  detail: {
    llm: {
      'ja-JP': '{calls} 回 · 入力 {input} トークン · 出力 {output} トークン',
      'en-US': 'Calls: {calls} · input tokens: {input} · output tokens: {output}',
      'fr-FR': 'Appels : {calls} · jetons en entrée : {input} · jetons en sortie : {output}',
      'de-DE': 'Aufrufe: {calls} · Eingabe-Tokens: {input} · Ausgabe-Tokens: {output}',
      'hi-IN': 'कॉल: {calls} · इनपुट टोकन: {input} · आउटपुट टोकन: {output}',
      'id-ID': 'Panggilan: {calls} · token masukan: {input} · token keluaran: {output}',
      'it-IT': 'Chiamate: {calls} · token in ingresso: {input} · token in uscita: {output}',
      'ko-KR': '호출 {calls}회 · 입력 토큰 {input} · 출력 토큰 {output}',
      'pt-BR': 'Chamadas: {calls} · tokens de entrada: {input} · tokens de saída: {output}',
      'es-419': 'Llamadas: {calls} · tokens de entrada: {input} · tokens de salida: {output}',
      'es-ES': 'Llamadas: {calls} · tokens de entrada: {input} · tokens de salida: {output}'
    },
    searches: {
      'ja-JP': 'Web 検索 {searches} 回',
      'en-US': 'web searches: {searches}',
      'fr-FR': 'recherches web : {searches}',
      'de-DE': 'Websuchen: {searches}',
      'hi-IN': 'वेब खोज: {searches}',
      'id-ID': 'pencarian web: {searches}',
      'it-IT': 'ricerche web: {searches}',
      'ko-KR': '웹 검색 {searches}회',
      'pt-BR': 'buscas na web: {searches}',
      'es-419': 'búsquedas web: {searches}',
      'es-ES': 'búsquedas web: {searches}'
    },
    live: {
      'ja-JP': '{minutes} 分',
      'en-US': '{minutes} min',
      'fr-FR': '{minutes} min',
      'de-DE': '{minutes} Min.',
      'hi-IN': '{minutes} मिनट',
      'id-ID': '{minutes} menit',
      'it-IT': '{minutes} min',
      'ko-KR': '{minutes}분',
      'pt-BR': '{minutes} min',
      'es-419': '{minutes} min',
      'es-ES': '{minutes} min'
    },
    agent: {
      'ja-JP': 'ジョブ {jobs} 件',
      'en-US': 'Jobs: {jobs}',
      'fr-FR': 'Tâches : {jobs}',
      'de-DE': 'Jobs: {jobs}',
      'hi-IN': 'काम: {jobs}',
      'id-ID': 'Pekerjaan: {jobs}',
      'it-IT': 'Incarichi: {jobs}',
      'ko-KR': '작업 {jobs}건',
      'pt-BR': 'Jobs: {jobs}',
      'es-419': 'Trabajos: {jobs}',
      'es-ES': 'Trabajos: {jobs}'
    }
  },
  agentNote: {
    'ja-JP': 'Claude Code が報告した金額です。',
    'en-US': 'The amount Claude Code reports.',
    'fr-FR': 'Le montant indiqué par Claude Code.',
    'de-DE': 'Der Betrag, den Claude Code meldet.',
    'hi-IN': 'यह रक़म Claude Code बताता है।',
    'id-ID': 'Jumlah yang dilaporkan Claude Code.',
    'it-IT': "L'importo indicato da Claude Code.",
    'ko-KR': 'Claude Code가 보고한 금액입니다.',
    'pt-BR': 'O valor informado pelo Claude Code.',
    'es-419': 'El monto que informa Claude Code.',
    'es-ES': 'El importe que indica Claude Code.'
  },
  gptLiveNote: {
    'ja-JP': 'セッションが開いていた時間の料金です。答えを作った会話モデルの料金は、会話モデルに入っています。',
    'en-US': 'The charge for the time the session was open. The conversation model that wrote the answers is counted under its own line.',
    'fr-FR': "Le coût du temps pendant lequel la session était ouverte. Le modèle de conversation qui a rédigé les réponses est compté sur sa propre ligne.",
    'de-DE': 'Die Kosten für die Zeit, in der die Sitzung offen war. Das Gesprächsmodell, das die Antworten geschrieben hat, steht in einer eigenen Zeile.',
    'hi-IN': 'सेशन जितनी देर खुला रहा, उसका ख़र्च। जवाब लिखने वाले बातचीत के मॉडल का ख़र्च उसकी अपनी पंक्ति में है।',
    'id-ID': 'Biaya selama sesi terbuka. Model percakapan yang menyusun jawaban dihitung di barisnya sendiri.',
    'it-IT': 'Il costo del tempo in cui la sessione è rimasta aperta. Il modello di conversazione che ha scritto le risposte è conteggiato nella sua riga.',
    'ko-KR': '세션이 열려 있던 시간의 요금입니다. 답변을 만든 대화 모델의 요금은 대화 모델 항목에 들어 있습니다.',
    'pt-BR': 'O custo do tempo em que a sessão ficou aberta. O modelo de conversa que escreveu as respostas aparece na própria linha.',
    'es-419': 'El costo del tiempo que la sesión estuvo abierta. El modelo de conversación que escribió las respuestas aparece en su propia línea.',
    'es-ES': 'El coste del tiempo que la sesión ha estado abierta. El modelo de conversación que ha escrito las respuestas aparece en su propia línea.'
  },
  codexNote: {
    'ja-JP': 'Codex は金額を報告しないので、Codex のジョブの料金はここに含まれません。',
    'en-US': 'Codex reports no amount, so the cost of Codex jobs is not included here.',
    'fr-FR': "Codex n'indique aucun montant : le coût des tâches Codex n'est pas inclus ici.",
    'de-DE': 'Codex meldet keinen Betrag, deshalb fehlen hier die Kosten der Codex-Jobs.',
    'hi-IN': 'Codex कोई रक़म नहीं बताता, इसलिए Codex के कामों का ख़र्च यहाँ शामिल नहीं है।',
    'id-ID': 'Codex tidak melaporkan jumlah biaya, jadi biaya pekerjaan Codex tidak termasuk di sini.',
    'it-IT': 'Codex non indica alcun importo, quindi il costo degli incarichi Codex non è incluso qui.',
    'ko-KR': 'Codex는 금액을 보고하지 않으므로 Codex 작업의 요금은 여기에 포함되지 않습니다.',
    'pt-BR': 'O Codex não informa valores, então o custo dos jobs do Codex não entra aqui.',
    'es-419': 'Codex no informa montos, así que el costo de los trabajos de Codex no se incluye aquí.',
    'es-ES': 'Codex no indica importes, así que el coste de los trabajos de Codex no se incluye aquí.'
  },
  unpriced: {
    'ja-JP': '料金表にないモデル',
    'en-US': 'Not in the price list',
    'fr-FR': 'Absent des tarifs',
    'de-DE': 'Nicht in der Preisliste',
    'hi-IN': 'क़ीमत सूची में नहीं',
    'id-ID': 'Tidak ada di daftar harga',
    'it-IT': 'Non nel listino',
    'ko-KR': '가격표에 없는 모델',
    'pt-BR': 'Fora da tabela de preços',
    'es-419': 'No está en la lista de precios',
    'es-ES': 'No está en la lista de precios'
  },
  errors: {
    unreadable: {
      'ja-JP': 'API の利用記録を読み込めません: {file}: {detail}',
      'en-US': "Couldn't read the API usage record: {file}: {detail}",
      'fr-FR': "Impossible de lire le relevé d'utilisation des API : {file} : {detail}",
      'de-DE': 'Das Protokoll der API-Nutzung ließ sich nicht lesen: {file}: {detail}',
      'hi-IN': 'API के इस्तेमाल का रिकॉर्ड पढ़ा नहीं जा सका: {file}: {detail}',
      'id-ID': 'Tidak bisa membaca catatan pemakaian API: {file}: {detail}',
      'it-IT': "Impossibile leggere il registro dell'uso delle API: {file}: {detail}",
      'ko-KR': 'API 사용 기록을 불러올 수 없습니다: {file}: {detail}',
      'pt-BR': 'Não foi possível ler o registro de uso das APIs: {file}: {detail}',
      'es-419': 'No se pudo leer el registro de uso de las API: {file}: {detail}',
      'es-ES': 'No se puede leer el registro de uso de las API: {file}: {detail}'
    },
    invalid: {
      'ja-JP': 'API の利用記録の内容を読み取れません。{file} を確認してください: {detail}',
      'en-US': 'The API usage record could not be understood. Check {file}: {detail}',
      'fr-FR': "Le contenu du relevé d'utilisation des API est incompréhensible. Vérifiez {file} : {detail}",
      'de-DE': 'Das Protokoll der API-Nutzung ließ sich nicht verstehen. Prüfen Sie {file}: {detail}',
      'hi-IN': 'API के इस्तेमाल का रिकॉर्ड समझ में नहीं आया। {file} देखें: {detail}',
      'id-ID': 'Isi catatan pemakaian API tidak terbaca. Periksa {file}: {detail}',
      'it-IT': "Non è stato possibile interpretare il registro dell'uso delle API. Controlla {file}: {detail}",
      'ko-KR': 'API 사용 기록의 내용을 읽을 수 없습니다. {file} 파일을 확인하십시오: {detail}',
      'pt-BR': 'Não foi possível entender o registro de uso das APIs. Confira {file}: {detail}',
      'es-419': 'No se pudo entender el registro de uso de las API. Revisa {file}: {detail}',
      'es-ES': 'No se ha podido entender el registro de uso de las API. Comprueba {file}: {detail}'
    }
  },
  chatgptPlan: {
    'ja-JP': 'ChatGPT プラン',
    'en-US': 'ChatGPT plan',
    'fr-FR': 'Forfait ChatGPT',
    'de-DE': 'ChatGPT-Abo',
    'hi-IN': 'ChatGPT प्लान',
    'id-ID': 'Paket ChatGPT',
    'it-IT': 'Piano ChatGPT',
    'ko-KR': 'ChatGPT 요금제',
    'pt-BR': 'Plano do ChatGPT',
    'es-419': 'Plan de ChatGPT',
    'es-ES': 'Plan de ChatGPT'
  }
})
