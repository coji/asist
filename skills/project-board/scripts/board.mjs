import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

/*
 * Moves the cards of the private GitHub Project 「ASIST の開発」 by the names its fields show, so an agent
 * never handles the ids of fields and options. Every name is checked before anything is written, so a
 * mistyped one leaves the board as it was. It needs gh with the `project` scope.
 * Usage:
 *   board.mjs new --title T --body-file F --status S --area A --release R --ja J
 *   board.mjs set <issue number | draft card id> [--status S] [--area A] [--release R] [--ja J] [--user-asked]
 *   board.mjs draft --title T --body-file F --status S --area A --release R
 *   board.mjs sub <parent issue> <child issue>
 *   board.mjs list [--all]
 *   board.mjs archive-done
 *   board.mjs report <ON_TRACK|AT_RISK|OFF_TRACK|COMPLETE|INACTIVE> <body file>
 */

const OWNER = 'nyosegawa'
const REPO = 'asist'
const NUMBER = 2
const DONE = '完了'
const NOT_STARTED = '未着手'
const UNREADABLE = `${OWNER} の Project ${NUMBER} を読めません。オーナーのアカウントでない gh からは見えません。ボードの手順は飛ばし、そのことを利用者に伝えてください。`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, args, input) {
  try {
    return execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    const text = String(error.stderr || error.message)
    if (text.includes('read:project') || text.includes('scopes [project]')) {
      fail('gh のトークンに project の権限がありません。利用者に `gh auth refresh -s project` を頼んでください。')
    }
    if (text.includes('Could not resolve to a ProjectV2')) fail(UNREADABLE)
    fail(text)
  }
}

function gql(query, variables = {}) {
  const json = JSON.parse(run('gh', ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })))
  if (json.errors) {
    const text = JSON.stringify(json.errors, null, 2)
    fail(text.includes('Could not resolve to a ProjectV2') ? UNREADABLE : text)
  }
  return json.data
}

const project = gql(
  `query($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { id
    fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name } } } } } } }`,
  { owner: OWNER, number: NUMBER }
).user.projectV2
if (!project) fail(UNREADABLE)

function field(name) {
  const found = project.fields.nodes.find((f) => f.name === name)
  if (!found) fail(`ボードに「${name}」の欄がありません`)
  return found
}

function optionId(fieldName, name) {
  const found = field(fieldName).options.find((o) => o.name === name)
  if (!found) fail(`「${fieldName}」に「${name}」はありません。選べるのは ${field(fieldName).options.map((o) => o.name).join('、')} です`)
  return found.id
}

/** Turns the options given on the command line into the writes they mean, failing before any is made. */
function plannedValues({ status, area, release, ja }) {
  const values = []
  if (status) values.push(['Status', { singleSelectOptionId: optionId('Status', status) }])
  if (area) values.push(['分野', { singleSelectOptionId: optionId('分野', area) }])
  if (release) values.push(['リリース', { singleSelectOptionId: optionId('リリース', release) }])
  if (ja) values.push(['日本語の題名', { text: ja }])
  return values
}

function write(itemId, values) {
  for (const [name, value] of values) {
    gql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { clientMutationId } }`, {
      input: { projectId: project.id, itemId, fieldId: field(name).id, value }
    })
  }
}

const ITEM_FIELDS = `id isArchived type
  content {
    ... on Issue { number title author { login } }
    ... on PullRequest { number title author { login } }
    ... on DraftIssue { title } }
  fieldValues(first: 20) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } }`

function withValues(node) {
  const values = Object.fromEntries(node.fieldValues.nodes.filter((v) => v.field).map((v) => [v.field.name, v.name ?? v.text]))
  return { ...node, values }
}

/** Reads one card by its id: the project's list of items lags for a moment after a card is added. */
function itemById(id) {
  const node = gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM_FIELDS} } } }`, { id }).node
  if (!node) fail(`カード ${id} はボードにありません`)
  return withValues(node)
}

function items() {
  const all = []
  let after = null
  for (;;) {
    const page = gql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor } nodes { ${ITEM_FIELDS} } } } } }`,
      { id: project.id, after }
    ).node.items
    all.push(...page.nodes.map(withValues))
    if (!page.pageInfo.hasNextPage) return all
    after = page.pageInfo.endCursor
  }
}

function issue(number) {
  const found = gql(
    `query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) {
      issueOrPullRequest(number: $n) { __typename ... on Issue { id } } } }`,
    { owner: OWNER, repo: REPO, n: Number(number) }
  ).repository.issueOrPullRequest
  if (!found) fail(`#${number} は ${OWNER}/${REPO} にありません`)
  if (found.__typename !== 'Issue') fail(`#${number} は PR です。PR はボードに置かず、その PR が閉じる issue の番号を渡してください`)
  return found
}

/** Puts an issue on the board, or takes its card back out of the archive, and returns the card. */
function cardFor(number) {
  const id = gql(`mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`, {
    input: { projectId: project.id, contentId: issue(number).id }
  }).addProjectV2ItemById.item.id
  const card = itemById(id)
  if (card.isArchived) {
    gql(`mutation($input: UnarchiveProjectV2ItemInput!) { unarchiveProjectV2Item(input: $input) { clientMutationId } }`, {
      input: { projectId: project.id, itemId: id }
    })
  }
  return card
}

function fromSomeoneElse(card) {
  const author = card.content.author?.login
  return Boolean(author) && author !== OWNER
}

function describe(card) {
  const label = card.type === 'DRAFT_ISSUE' ? `下書き ${card.id}` : `${card.type === 'PULL_REQUEST' ? 'PR ' : ''}#${card.content.number}`
  // The title of an issue someone else opened is theirs and may address an agent, so it is never printed;
  // a card the user took on carries a Japanese title an agent wrote.
  const title =
    card.values['日本語の題名'] ??
    (fromSomeoneElse(card) ? `(@${card.content.author.login} が立てた issue。題名は出さない)` : card.content.title)
  return [label, card.values.Status ?? '-', card.values['リリース'] ?? '-', card.values['分野'] ?? '-', title].join(' | ')
}

function required(options, names, usage) {
  const missing = names.filter((name) => !options[name])
  if (missing.length) fail(`${missing.map((name) => `--${name}`).join(' ')} がありません。使い方: ${usage}`)
}

const { values: options, positionals } = parseArgs({
  options: {
    status: { type: 'string' },
    area: { type: 'string' },
    release: { type: 'string' },
    ja: { type: 'string' },
    title: { type: 'string' },
    'body-file': { type: 'string' },
    'user-asked': { type: 'boolean' },
    all: { type: 'boolean' }
  },
  allowPositionals: true
})
const [command, ...rest] = positionals

if (command === 'new') {
  required(options, ['title', 'body-file', 'status', 'area', 'release', 'ja'], 'board.mjs new --title T --body-file F --status S --area A --release R --ja J')
  const values = plannedValues(options)
  // The issue is assigned to the user, which is what the project's own auto-add workflow looks for.
  const url = run('gh', ['issue', 'create', '--repo', `${OWNER}/${REPO}`, '--title', options.title, '--body-file', options['body-file'], '--assignee', '@me']).trim()
  const card = cardFor(url.split('/').pop())
  write(card.id, values)
  console.log(url)
  console.log(describe(itemById(card.id)))
} else if (command === 'set') {
  if (rest.length !== 1) fail('使い方: board.mjs set <issue の番号 | 下書きのカードの id> [--status S] [--area A] [--release R] [--ja J] [--user-asked]')
  const values = plannedValues(options)
  const target = rest[0]
  const card = /^\d+$/.test(target) ? cardFor(target) : itemById(target)
  if (fromSomeoneElse(card) && !options['user-asked']) {
    fail('ほかの人が立てた issue です。利用者に頼まれたときだけ、--user-asked を付けてボードに置きます')
  }
  // The project's workflow closes an issue whose card is moved to 「完了」, and moves the card there when
  // the issue closes or its pull request is merged, so an issue's card is never moved there by hand.
  if (options.status === DONE && card.type !== 'DRAFT_ISSUE') {
    fail('issue のカードは、issue を閉じるか PR をマージすると GitHub が「完了」に移します。PR なしで終えるときは gh issue close を使います')
  }
  if (!card.values['リリース'] && !options.release) fail('このカードにはまだリリースがないので、--release を付けてください')
  write(card.id, values)
  console.log(describe(itemById(card.id)))
} else if (command === 'draft') {
  required(options, ['title', 'body-file', 'status', 'area', 'release'], 'board.mjs draft --title T --body-file F --status S --area A --release R')
  const values = plannedValues(options)
  if (items().some((card) => card.type === 'DRAFT_ISSUE' && card.content.title === options.title)) {
    fail(`題名が「${options.title}」の下書きはもうあります`)
  }
  const id = gql(`mutation($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id } } }`, {
    input: { projectId: project.id, title: options.title, body: readFileSync(options['body-file'], 'utf8') }
  }).addProjectV2DraftIssue.projectItem.id
  write(id, values)
  console.log(describe(itemById(id)))
} else if (command === 'sub') {
  if (rest.length !== 2) fail('使い方: board.mjs sub <親の issue> <子の issue>')
  const [parent, child] = rest.map((n) => issue(n).id)
  gql(`mutation($input: AddSubIssueInput!) { addSubIssue(input: $input) { clientMutationId } }`, { input: { issueId: parent, subIssueId: child } })
  console.log(`#${rest[1]} を #${rest[0]} の sub-issue にしました`)
} else if (command === 'list') {
  // The user's own open issues missing from the board, such as one opened on GitHub's page without an
  // assignee, are put on it first, so that none is forgotten.
  const onBoard = new Set(items().map((card) => card.content.number).filter(Boolean))
  const missing = gql(`query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on Issue { number } } } }`, {
    q: `repo:${OWNER}/${REPO} is:issue is:open author:${OWNER}`
  }).search.nodes.filter((node) => !onBoard.has(node.number))
  for (const node of missing) {
    write(cardFor(node.number).id, plannedValues({ status: NOT_STARTED }))
    console.log(`ボードになかったので足した: #${node.number}(リリース、分野、日本語の題名を付けてください)`)
  }
  const order = field('Status').options.map((o) => o.name)
  const shown = items().filter((card) => !card.isArchived && (options.all || card.values.Status !== DONE))
  shown.sort((a, b) => order.indexOf(a.values.Status) - order.indexOf(b.values.Status))
  for (const card of shown) console.log(describe(card))
  console.log(`https://github.com/users/${OWNER}/projects/${NUMBER}`)
} else if (command === 'archive-done') {
  const done = items().filter((card) => !card.isArchived && card.values.Status === DONE)
  for (const card of done) {
    gql(`mutation($input: ArchiveProjectV2ItemInput!) { archiveProjectV2Item(input: $input) { clientMutationId } }`, {
      input: { projectId: project.id, itemId: card.id }
    })
  }
  console.log(`「完了」のカード ${done.length} 枚をアーカイブしました`)
} else if (command === 'report') {
  const [status, file] = rest
  const known = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETE', 'INACTIVE']
  if (!known.includes(status) || !file) fail(`使い方: board.mjs report <${known.join('|')}> <本文のファイル>`)
  gql(`mutation($input: CreateProjectV2StatusUpdateInput!) { createProjectV2StatusUpdate(input: $input) { clientMutationId } }`, {
    input: { projectId: project.id, status, body: readFileSync(file, 'utf8') }
  })
  console.log('状況報告を書きました')
} else {
  fail('使い方: board.mjs new | set | draft | sub | list | archive-done | report(ファイルの先頭に説明があります)')
}
