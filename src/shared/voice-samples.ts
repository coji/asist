/**
 * What the bundled samples of the voices say, by the BCP 47 tag of the language they are read in. They are
 * spoken and never shown, so they live here rather than in the dictionary: the same three sentences in each
 * language Qwen3-TTS reads for a conversation locale. The voices of the live engines and of Irodori-TTS are
 * sampled in Japanese alone.
 */
export const VOICE_SAMPLE_TEXT = {
  ja: 'こんにちは。声のテストです。今日はいい天気ですね。',
  en: "Hello. This is a voice test. It's a nice day today, isn't it?",
  fr: "Bonjour. Ceci est un test de voix. Il fait beau aujourd'hui, n'est-ce pas ?",
  de: 'Hallo. Das ist ein Stimmtest. Heute ist schönes Wetter, nicht wahr?',
  it: 'Ciao. Questa è una prova della voce. Oggi è proprio una bella giornata, vero?',
  ko: '안녕하세요. 목소리 테스트입니다. 오늘 날씨가 좋네요.',
  pt: 'Olá. Este é um teste de voz. Hoje está um dia bonito, não é?',
  es: 'Hola. Esta es una prueba de voz. Hoy hace un día muy bonito, ¿verdad?'
} as const

export type VoiceSampleLanguage = keyof typeof VOICE_SAMPLE_TEXT
