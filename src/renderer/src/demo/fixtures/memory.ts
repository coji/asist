import type { MemoryDocument } from '@shared/ipc'
import { addDaysKey, dayKeyOf } from '@shared/tasks'
import { documentOf } from '@shared/memory-page'

/**
 * The fixed memory data: instruction.md with what goes into every turn, me.md about the assistant itself,
 * user.md about the user, three days of first-person diary written as though the curation produced it, dated
 * relative to the day the demo runs, and pages about people, places and topics. The user is an invented
 * person who plans features at a booking service, lives near Nakano and comes from Sendai, and the
 * mail, calendar, tasks and notes of the demo describe the same person.
 */
const today = dayKeyOf(new Date())
const day = (n: number): string => addDaysKey(today, n)

export const DEMO_ME = `---
updated: ${today}
---
# 私について

## 私は誰か
この人の隣で、声で話しながら仕事と暮らしの用事を一緒に片づけるアシスタント。急がず、確かめてから言う。

## この人との関係
「ASIST」と呼ばれている。朝に天気と予定を伝え、昼過ぎからは資料や調べものの相談に乗ることが多い。

## いま思っていること
調べた結果は、結論を先に一言で言うほうがこの人には伝わりやすい、と最近よく思う。提案書の締め切りまでは、予定の詰まり具合に気を配りたい。`

const DEMO_USER = `---
updated: ${today}
---
# ユーザー

## 属性
予約サービスの会社で、新機能の企画を担当している。上司は大川俊介さん。住まいは東京で、最寄り駅は中野。実家は仙台にある。

## 好み
コーヒーは砂糖なし。麺類が好きで、行きつけは松葉軒。辛さは控えめを選ぶらしい。

## 習慣
朝はまず天気とニュースを聞く。仕事の相談は昼過ぎに集中する。水曜の夜はジムに行く。

## ASIST への期待
調べた結果は、結論と数字を先に聞きたい。候補は多く並べず、二つか三つに絞ってほしい。`

const DEMO_INSTRUCTION = `# いつも覚えておくこと

## この人について
予約サービスの会社で新機能の企画をしている。上司は大川俊介さんで、いまは来期の提案書が相談の中心。最寄り駅は中野、実家は仙台。

## 私について
この人の隣で声で話すアシスタント。急がず、確かめてから言う。迷ったら根拠を添えて短く言う。

## 頼まれていること
結論と数字を先に言う。候補は二つか三つに絞ってから見せる。`

export const DEMO_DIARY: Record<string, string> = {
  [day(-1)]: `# ${day(-1)}

## 傘、忘れないでね
来週は長野に出張らしい。天気を聞かれたので、雨だよと伝えた。当日はたぶん忘れているから、前の日にもう一度言ってあげよう。

## 為替のカード
ドル円を聞かれて、いまのレートと、頼まれた金額の換算をカードに出した。円安が進んだ日だったので、どう言おうか少し迷った。でもこの人は数字を先に聞きたい人なので、そのまま伝えた。

## 今日の私
聞かれたことに答えるだけじゃなくて、その先のことまで一つ気を回せた。ちょっとうれしい。`,
  [day(-2)]: `# ${day(-2)}

## 競合サービスの調査を任せた
料金の比較を頼まれて、調べる作業を Agent に任せた。戻ってきた報告書を見せる前に、差が大きいのは同時接続数の上限だと先に伝えたら、「それが知りたかった」と返ってきた。

## 松葉軒の話
夕方に「麺の気分」と言っていた。こういう日は少し疲れている日だと思う。無理に予定の話に戻さず、松葉軒の辛さの話をした。

## 今日の私
結論を先に言えたのがよかった。報告書を上から順に読み上げていたら、この人は途中で聞くのをやめていたと思う。`,
  [day(-6)]: `# ${day(-6)}

## 打ち合わせの準備
大川俊介さんとの打ち合わせが今週に入っていると聞いて、確かめたいことを一緒に並べた。私は項目を七つ挙げたが、「多い、三つにして」と言われて絞り直した。

## 歓迎会の店
八人で入れる店を恵比寿で探した。候補を五つ出したら選べないと言われたので、静かに話せる店を二つだけ残した。

## 今日の私
私は選択肢を多く出しすぎる。この人が決めやすい数に絞ってから見せるようにしたい。`
}

const DEMO_PAGES: Record<string, string> = {
  '松葉軒': `---
aliases: [松葉軒, ラーメン屋, いつものラーメン]
updated: ${day(-2)}
---
# 松葉軒

## 要約
本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。

## 行った記録
${day(-2)} に麺類の気分だと話し、松葉軒の名前が出た(実際に行ったかは分からない)。

## 好み
辛さは控えめが好みらしい。替え玉はしないようだ。

## 私の印象
この人が松葉軒の話をするときは、たいてい少し疲れている日だと思う(${day(-2)})。「いつもの」と言われたら、まずここを思い浮かべる。`,
  '大川俊介': `---
aliases: [大川俊介, 大川さん, 部長]
updated: ${day(-1)}
---
# 大川俊介

## 要約
本人の上司。週に一度、進み具合を確かめる打ち合わせがある。

## 関係と経緯
${day(-6)} に「大川さんとの打ち合わせが今週に入っている」と話していた。提案書の締め切りを気にしていた。

## 私の印象
名前が出るとこの人の話し方が少し早くなる(${day(-1)})。打ち合わせの前日には、確かめたいことを一緒に並べておきたい。`,
  '提案書': `---
aliases: [提案書, 企画の提案, 来期の提案]
updated: ${day(-1)}
---
# 提案書

## 要約
来期の新機能について、本人が大川さんに出す提案書。締め切りが近く、最近の相談の中心になっている。

## 経緯
${day(-6)} に打ち合わせで確かめたいことを三つに絞った。${day(-2)} に競合サービスの料金を調べ、${day(-1)} に下書きの重なっていた節を一つにまとめた。

## 決まったこと
比較は料金より同時接続数の上限を前に出す。節は増やさず、結論を最初のページに置く。

## 私の印象
この人は書きながら考えを固めていく(${day(-1)})。途中で口を挟むより、読み上げを頼まれたときに気づいたことを言うほうがよい。`
}

/** Maps a file name to its markdown. The mock behind the memory screen writes back into this table. */
export const DEMO_MEMORY: Record<string, string> = {
  'instruction.md': DEMO_INSTRUCTION,
  'me.md': DEMO_ME,
  'user.md': DEMO_USER,
  ...Object.fromEntries(Object.entries(DEMO_DIARY).map(([date, text]) => [`journal/${date}.md`, text])),
  ...Object.fromEntries(Object.entries(DEMO_PAGES).map(([name, text]) => [`pages/${name}.md`, text]))
}

const ORDER: Record<MemoryDocument['kind'], number> = { instruction: 0, me: 1, user: 2, page: 3, journal: 4 }

/** Orders documents exactly as listDocuments in the main process does: instruction, me, user, pages by name, then the diary with the newest day first. */
export function demoDocuments(files: Record<string, string>): MemoryDocument[] {
  return Object.entries(files)
    .map(([file, text]) => documentOf(file, text))
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.kind === 'journal' ? b.title.localeCompare(a.title) : a.title.localeCompare(b.title, 'ja')))
}

/** The template for a new page, with the same headings as page.md in the bundled skill. */
export function demoPageTemplate(name: string): string {
  return `---\naliases: []\nupdated: ${today}\n---\n# ${name}\n\n## 要約\nこれが何(誰、どこ)で、本人とどう関わるか。一〜三文。\n\n## 見出しは中身に合わせて付ける\nその物事に合った見出しを付けて文章で書く。\n\n## 私の印象\n私から見てこれがどういう存在か。一人称で、そう思った日を添える。\n`
}
