/**
 * The words of the generated documents: business prose in Japanese with English terms, as the documents ASIST's
 * users keep are written, from a seeded generator so that every run writes the same words.
 */

/** A generator of numbers in [0, 1) that gives the same sequence for the same seed. */
export function random(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

export const pick = (next, list) => list[Math.floor(next() * list.length)]

const SUBJECTS = ['主要な取引先との契約', '新しい物流センター', '関東地区の店舗', 'オンライン販売', '海外向けの出荷', '来期の採用計画', '顧客アンケートの結果', '基幹システムの移行', 'サポート窓口', '新製品の試作']
const FINDINGS = [
  'は前年同期と比べて {n}% 伸びました。',
  'は計画より {n} 日遅れていますが、月末には取り戻せる見込みです。',
  'の費用は {n} 万円で、予算の範囲に収まっています。',
  'について、{n} 件の改善要望が寄せられました。',
  'は {n} 月から段階的に切り替えます。',
  'の満足度は 5 段階で平均 {d} でした。',
  'では、ピーク時の待ち時間が {n} 分まで縮みました。'
]
const NOTES = [
  'The quarterly revenue grew by {n} percent over the same period last year.',
  '担当者からは、現場の負担がまだ大きいという声も出ています。',
  '詳しい数字は付録の表にまとめました。',
  'リスクとして、為替の変動と部材の調達の遅れが挙げられます。',
  'KPI は来月の定例会議で見直します。',
  '今後は月に一度、進み具合を経営会議に報告します。',
  '比較のために、昨年の同じ時期の数字も併せて載せています。'
]

/** One sentence with numbers in it. */
export function sentence(next) {
  const n = 2 + Math.floor(next() * 40)
  if (next() < 0.35) return pick(next, NOTES).replace('{n}', String(n))
  return pick(next, SUBJECTS) + pick(next, FINDINGS).replace('{n}', String(n)).replace('{d}', (3 + next() * 2).toFixed(1))
}

/** A paragraph of `count` sentences. */
export function paragraph(next, count) {
  return Array.from({ length: count }, () => sentence(next)).join('')
}

const TOPICS = ['売上の推移', '費用の内訳', '地域別の動向', '顧客の声', '業務の改善', '来期の見通し', '設備投資', '人員の配置', '品質の管理', '新規事業']

/** A heading for section `index`, such as "第 3 章 地域別の動向". */
export function heading(next, index) {
  return `第 ${index} 章 ${pick(next, TOPICS)}`
}

/** A short title, such as a slide's or a section's. */
export function title(next) {
  return `${pick(next, TOPICS)}について`
}

export const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
