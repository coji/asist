import regions from './data/regions.json'
import { CONVERSATION_LOCALES, type PromptText } from '@shared/conversation-locale'
import type { JmaWeatherLocation, WeatherIssue } from '@shared/weather'

/**
 * What the model is told when a place name resolves to no Japanese municipality, or to several. The
 * conversation can be held in any language while the region stays Japan, so each hint carries both
 * prompt languages and show_weather picks the one of the turn.
 */
const HINTS = {
  notFound: {
    ja: '一致する都道府県および市区町村がありません。正式な地域名を指定してください。',
    en: 'No prefecture or municipality of Japan has that name. Give the official name of a prefecture or municipality, written in Japanese or in romaji (for example "Fuchu, Tokyo").'
  },
  ambiguous: {
    ja: '同名の市区町村が複数あります。候補を示してユーザーに確認し、都道府県名を付けて再実行してください。',
    en: 'Several places share that name. Offer the candidates to the user, then call again with the location of the one they choose.'
  },
  unavailable: {
    ja: 'この市区町村に対応する気象庁の予報区域がありません。',
    en: 'The Japan Meteorological Agency has no forecast area for this municipality.'
  }
} as const satisfies Record<string, PromptText>

type Prefecture = (typeof regions.prefectures)[number]
type Municipality = (typeof regions.municipalities)[number]

/** A place a name stands for: a municipality, or a prefecture through its representative municipality. */
interface Place {
  municipality: Municipality
  prefecture?: Prefecture
}
const prefecturePlace = (prefecture: Prefecture): Place => ({
  prefecture,
  municipality: regions.municipalities.find((p) => p.code === prefecture.representativeCode)!
})

const japaneseNames = new Map<string, Municipality[]>()
for (const place of regions.municipalities) {
  for (const name of [place.name, place.prefecture + place.name]) {
    japaneseNames.set(name, [...(japaneseNames.get(name) ?? []), place])
  }
}

function namedInJapanese(requested: string): Place[] {
  const prefecture = regions.prefectures.find((p) => p.name === requested)
  if (prefecture) return [prefecturePlace(prefecture)]
  return (japaneseNames.get(requested) ?? []).map((municipality) => ({ municipality }))
}

type Kind = 'prefecture' | 'city' | 'ward' | 'town' | 'village'
/** The words English and romanized Japanese write after a name to say what kind of place it is. */
const KIND_WORDS = new Map<string, Kind>([
  ['prefecture', 'prefecture'], ['metropolis', 'prefecture'], ['ken', 'prefecture'], ['fu', 'prefecture'], ['to', 'prefecture'],
  ['city', 'city'], ['shi', 'city'],
  ['ward', 'ward'], ['ku', 'ward'],
  ['town', 'town'], ['machi', 'town'], ['cho', 'town'],
  ['village', 'village'], ['mura', 'village'], ['son', 'village']
])
const SUFFIX_KINDS = new Map<string, Kind>([['市', 'city'], ['区', 'ward'], ['町', 'town'], ['村', 'village']])
const japaneseKind = (municipality: Municipality): Kind | undefined => SUFFIX_KINDS.get(municipality.name.at(-1)!)

interface Romaji {
  base: string
  kind?: Kind
}
/**
 * A name in Latin letters as the letters of its words run together, so that case, the marks of long
 * vowels ("Tōkyō") and the spaces or hyphens inside a name ("Sanyo-Onoda") do not count, with the kind
 * of place the word after it names. The agency's own English writes a long vowel as "oh", "ou" or one
 * vowel ("Minoh", "Kounosu", "Ota") and n or m before b, m and p ("Tanba", "Gotemba"), so each is read as
 * one spelling, and names that become the same are offered as candidates.
 */
function romaji(text: string): Romaji {
  const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s\-'’.]+/u).filter(Boolean)
  const kind = words.length > 1 ? KIND_WORDS.get(words.at(-1)!) : undefined
  const base = (kind ? words.slice(0, -1) : words)
    .join('')
    .replace(/oh(?![aiueo])/g, 'o')
    .replace(/ou/g, 'o')
    .replace(/([aiueo])\1+/g, '$1')
    .replace(/m(?=[bmp])/g, 'n')
  return { base, kind }
}

/** Japan as each conversation language names it, which a place name may end with ("Osaka, Japan"). */
const JAPAN = new Set(
  CONVERSATION_LOCALES.map((locale) => romaji(new Intl.DisplayNames([locale], { type: 'region' }).of('JP')!).base)
)

/** The prefectures by their ids, which are their names in romaji. */
const prefecturesByRomaji = new Map(regions.prefectures.map((p) => [romaji(p.id).base, p]))
const prefectureNamed = ({ base, kind }: Romaji): Prefecture | undefined =>
  (kind ?? 'prefecture') === 'prefecture' ? prefecturesByRomaji.get(base) : undefined

/**
 * A municipality as the agency's English names it: "Sapporo" of "Sapporo City", and for a ward of Kobe or
 * Hiroshima, which the agency forecasts on its own, with the city that has to follow it ("Higashinada
 * Ward, Kobe City"), since a ward of the same name in another designated city has no English name here.
 * A ward the agency forecasts together with its city has no English name and is reached in Japanese.
 */
interface RomajiPlace extends Place {
  kinds: Set<Kind | undefined>
  city?: string
}
const romajiNames = new Map<string, RomajiPlace[]>()
for (const municipality of regions.municipalities) {
  if (!municipality.enName) continue
  const [own, city] = municipality.enName.split(',').map(romaji)
  // A ward of Tokyo is a "City" in the agency's English and a ward, "区", in its Japanese name.
  const kinds = new Set([own.kind, japaneseKind(municipality)])
  romajiNames.set(own.base, [...(romajiNames.get(own.base) ?? []), { municipality, kinds, city: city?.base }])
}

/** Whether what follows a name after its commas fits the place: the city a ward needs, then the prefecture. */
function followedBy({ municipality, city }: RomajiPlace, qualifiers: Romaji[]): boolean {
  const fits = [
    ...(city ? [(q: Romaji) => q.base === city && (q.kind ?? 'city') === 'city'] : []),
    (q: Romaji) => prefectureNamed(q)?.id === municipality.prefectureId
  ]
  return qualifiers.length >= fits.length - 1 && qualifiers.length <= fits.length && qualifiers.every((q, i) => fits[i](q))
}

/**
 * A name in romaji, as a conversation in another language writes the places of Japan, with what may
 * follow it after commas ("Fuchu, Tokyo, Japan"). A name that is a prefecture's is the prefecture, as
 * "Okinawa" is beside Okinawa City in it, unless a municipality of another prefecture shares the name
 * ("Ibaraki"), when both are candidates.
 */
function namedInRomaji(requested: string): Place[] {
  const [name, ...qualifiers] = requested.normalize('NFKD').split(/[,、]/).map(romaji)
  if (qualifiers.length > 0 && JAPAN.has(qualifiers.at(-1)!.base)) qualifiers.pop()
  const places = (romajiNames.get(name.base) ?? []).filter(
    (place) => (!name.kind || place.kinds.has(name.kind)) && followedBy(place, qualifiers)
  )
  const prefecture = qualifiers.length === 0 ? prefectureNamed(name) : undefined
  if (prefecture)
    return [prefecturePlace(prefecture), ...places.filter((p) => p.municipality.prefectureId !== prefecture.id)]
  if (name.kind) return places
  // English names a city without its kind, so a name one city has is that city when the others are towns
  // or villages, as "Yokohama" is beside the town of Yokohama in Aomori.
  const cities = places.filter((p) => japaneseKind(p.municipality) === 'city')
  const towns = places.filter((p) => ['town', 'village'].includes(japaneseKind(p.municipality)!))
  return cities.length === 1 && cities.length + towns.length === places.length ? cities : places
}

export function resolveWeatherLocation(requested: string): JmaWeatherLocation | WeatherIssue {
  // The table's own names are Japanese, so a name in Latin letters is romaji.
  const named = /\p{Script=Latin}/u.test(requested) ? namedInRomaji(requested) : namedInJapanese(requested)
  // A municipality without a forecast area is listed so that its name is answered with
  // location_unavailable rather than not found, so when it shares its name with one that has an area, as
  // "国後郡泊村" does with "古宇郡泊村" in Hokkaido, the name means the one with the area.
  const forecast = named.filter((p) => p.municipality.officeCode)
  const matches = forecast.length ? forecast : named
  if (matches.length === 0)
    return {
      status: 'location_not_found',
      requestedLocation: requested,
      hint: HINTS.notFound
    }
  if (matches.length > 1)
    return {
      status: 'location_ambiguous',
      requestedLocation: requested,
      candidates: matches.map(({ municipality: p, prefecture }) => ({
        location: prefecture?.name ?? p.prefecture + p.name,
        municipalityCode: p.code
      })),
      hint: HINTS.ambiguous
    }
  const { municipality: p, prefecture } = matches[0]
  if (!p.officeCode)
    return { status: 'location_unavailable', requestedLocation: requested, hint: HINTS.unavailable }
  return {
    source: 'jma',
    requested,
    // The municipality is what a card stands for: a prefecture and its representative municipality are one card.
    cardId: p.code,
    timeZone: 'Asia/Tokyo',
    municipalityCode: p.code,
    name: p.name,
    prefecture: p.prefecture,
    prefectureId: p.prefectureId,
    forecastAreaCode: p.forecastAreaCode!,
    forecastAreaName: p.forecastAreaName!,
    officeCode: p.officeCode,
    stationId: p.stationId!,
    stationName: p.stationName!,
    usedRepresentative: !!prefecture || !!p.representativeArea
  }
}
export function weeklyCandidates(
  location: JmaWeatherLocation
): Array<{ week: string; amedas: string }> {
  const week = regions.weekly as Record<string, Array<{ week: string; amedas: string }>>
  const codes = (regions.weekly05 as Record<string, string[]>)[location.forecastAreaCode]
  return week[location.officeCode].filter((p) => codes.includes(p.week))
}
export function forecastOffice(code: string): string {
  return code === '014030' ? '014100' : code === '460040' ? '460100' : code
}
