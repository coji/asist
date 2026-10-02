"""The rules of ASIST's memory markdown, as the curation skills' scripts check them.

ASIST applies the same rules in TypeScript (src/shared/memory-format.ts) when it merges a curation, and both
read their values from memory-format.json beside this file. They are written twice because the curation
Agent runs its checks through the uv ASIST ships, where no Node and no Python of the user's may be, while
ASIST itself runs in Electron. tests/fixtures/memory-format-cases.json holds the cases both must answer the
same. This file sits two folders above the skills' scripts/, in the app and where ASIST installs the skill.
It uses the standard library only, so that uv runs it on its own Python without installing anything.
"""

from __future__ import annotations

import json
import math
import os
import re

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'memory-format.json'), encoding='utf-8') as _file:
    FORMAT = json.load(_file)

SUMMARY_HEADING = FORMAT['summaryHeading']
PROMPT_DOCUMENTS = [(document['kind'], document['file']) for document in FORMAT['promptDocuments']]
PROMPT_DOCUMENT_MAX_TOKENS = FORMAT['promptDocumentMaxTokens']
SECTION_MAX_CHARS = FORMAT['sectionMaxChars']

# The whitespace of JavaScript's \s and trim, which Python's \s and strip read differently (they take the
# control characters 0x1c to 0x1f and 0x85, and leave out 0xfeff).
_SPACE = ''.join(chr(code) for start, end in FORMAT['whitespace'] for code in range(start, end + 1))
_S = '[' + re.escape(_SPACE) + ']'


def _within(ranges, code):
    return any(start <= code <= end for start, end in ranges)


def _is_space(code):
    return _within(FORMAT['whitespace'], code)


def _trim(text):
    return text.strip(_SPACE)


def _trim_end(text):
    return text.rstrip(_SPACE)


def cap_length(text):
    """Characters, with the whitespace left out."""
    return sum(1 for character in text if not _is_space(ord(character)))


def _character_tokens(code):
    for weight in FORMAT['tokenWeights']:
        if (_is_space(code) if weight['name'] == 'whitespace' else _within(weight['ranges'], code)):
            return weight['weight']
    return FORMAT['otherWeight']


def token_estimate(text):
    """The tokens a conversation model is estimated to read for the text, by the kind of each character."""
    tokens = 0
    for character in text:
        tokens += _character_tokens(ord(character))
    return math.ceil(tokens)


def written_in_japanese(text):
    """Kana decide it: of the conversation languages, only Japanese writes them."""
    return re.search('[ぁ-ヿ]', text) is not None


_DATE = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
_OBSOLETE_KEYS = ('kind', 'links')
# JavaScript's dot takes no line terminator, where Python's takes everything but \n.
_DOT = '[^\n\r\u2028\u2029]'
_ITEM = re.compile('^' + _S + '*-' + _S + '*(' + _DOT + '+)$')
_KEY = re.compile('^([A-Za-z_]+)' + _S + '*:' + _S + '*(' + _DOT + '*)$')
_SPLIT = re.compile(_S + '+')


def _unquote(text):
    return re.sub('^["\']|["\']$', '', _trim(text))


def _split_lines(markdown):
    return re.split('\r?\n', markdown)


def _parse_frontmatter(lines):
    """The frontmatter, the line the body starts on, and whether the frontmatter is left open."""
    frontmatter = {'present': False, 'aliases': [], 'hasAliases': False, 'updated': None, 'obsoleteKeys': []}
    if not lines or _trim(lines[0]) != '---':
        return frontmatter, 0, False
    frontmatter['present'] = True
    list_key = None
    for i in range(1, len(lines)):
        raw = lines[i]
        if _trim(raw) == '---':
            return frontmatter, i + 1, False
        item = _ITEM.match(raw)
        if item and list_key:
            if list_key == 'aliases':
                frontmatter['aliases'].append(_unquote(item.group(1)))
            continue
        match = _KEY.match(raw)
        if not match:
            continue
        key, value = match.group(1), match.group(2)
        list_key = None
        if key in _OBSOLETE_KEYS:
            frontmatter['obsoleteKeys'].append(key)
            if not _trim(value):
                list_key = 'skip'
        elif key == 'updated':
            frontmatter['updated'] = _trim(value) or None
        elif key == 'aliases':
            frontmatter['hasAliases'] = True
            listed = re.sub(r'\]$', '', re.sub(r'^\[', '', _trim(value)))
            frontmatter['aliases'] = [alias for alias in (_unquote(part) for part in listed.split(',')) if alias]
            if not _trim(value):
                list_key = 'aliases'
    return frontmatter, len(lines), True


def _summary_for(markdown):
    return SUMMARY_HEADING['ja' if written_in_japanese(markdown) else 'en']


def _read_body(markdown):
    lines = _split_lines(markdown)
    frontmatter, body_start, unclosed = _parse_frontmatter(lines)
    title = None
    headed = False
    sections = []
    current = None
    for i in range(body_start, len(lines)):
        raw = lines[i]
        if raw.startswith('# '):
            title = _trim(raw[2:])
            continue
        if raw.startswith('## '):
            headed = True
            current = {'line': i + 1, 'heading': _trim(raw[3:]), 'text': ''}
            sections.append(current)
            continue
        if not _trim(raw):
            continue
        if current is None:
            current = {'line': i + 1, 'heading': _summary_for(markdown), 'text': ''}
            sections.append(current)
        current['text'] = current['text'] + '\n' + _trim_end(raw) if current['text'] else _trim_end(raw)
    return frontmatter, unclosed, title, headed, sections


def prompt_body(markdown):
    """A document that goes into every prompt, as the prompt carries it: without its frontmatter and `# ` line."""
    lines = _split_lines(markdown)
    _, body_start, _ = _parse_frontmatter(lines)
    return _trim('\n'.join(line for line in lines[body_start:] if not line.startswith('# ')))


def prompt_size(markdown):
    """Its tokens, and its characters without whitespace and its words, the units a curation cuts by."""
    body = prompt_body(markdown)
    return {'tokens': token_estimate(body), 'characters': cap_length(body), 'words': len([word for word in _SPLIT.split(body) if word])}


def text_for_tokens(size, tokens):
    """How much of the document's own text, in characters and in words, comes to `tokens` tokens."""
    def share(count):
        return 0 if size['tokens'] == 0 else math.ceil(tokens * count / size['tokens'])
    return {'characters': share(size['characters']), 'words': share(size['words'])}


_WINDOWS_DEVICE_NAME = re.compile(r'^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.' + _DOT + '*)?$', re.IGNORECASE)


def page_name_issue(name):
    """'characters', 'reserved' or None, for a page's name, its file name without .md."""
    if re.search(r'[/\\:*?"<>|]', name) or name.startswith('.'):
        return 'characters'
    if _WINDOWS_DEVICE_NAME.match(name):
        return 'reserved'
    return None


def _in_prompt(kind):
    return any(document_kind == kind for document_kind, _ in PROMPT_DOCUMENTS)


def document_issues(kind, markdown):
    """What in a document breaks the rules, as values; `kind` is me, user, page or journal."""
    frontmatter, unclosed, title, headed, sections = _read_body(markdown)
    issues = []
    if kind in ('user', 'me', 'page') and not frontmatter['present']:
        issues.append({'kind': 'frontmatterMissing'})
    if unclosed:
        issues.append({'kind': 'frontmatterUnclosed'})
    for key in frontmatter['obsoleteKeys']:
        issues.append({'kind': 'obsoleteKey', 'key': key})
    if kind in ('user', 'me') and frontmatter['hasAliases']:
        issues.append({'kind': 'aliasesOnlyOnPages'})
    if frontmatter['updated'] and not _DATE.match(frontmatter['updated']):
        issues.append({'kind': 'updatedNotDate'})
    if kind != 'journal' and title is None:
        issues.append({'kind': 'titleMissing'})
    if kind != 'me' and not headed:
        issues.append({'kind': 'noHeadings'})
    first_lines = {}
    for section in sections:
        line, heading = section['line'], section['heading']
        if heading in first_lines:
            issues.append({'kind': 'duplicateHeading', 'line': line, 'heading': heading, 'first': first_lines[heading]})
        else:
            first_lines[heading] = line
        length = cap_length(section['text'])
        if length == 0:
            issues.append({'kind': 'headingWithoutText', 'line': line, 'heading': heading})
        elif length > SECTION_MAX_CHARS and not _in_prompt(kind):
            issues.append({'kind': 'sectionTooLong', 'line': line, 'heading': heading, 'length': length})
    opening = sections[0]['heading'] if sections else None
    if kind == 'page' and opening is not None and opening not in (SUMMARY_HEADING['ja'], SUMMARY_HEADING['en']):
        issues.append({'kind': 'firstHeading', 'heading': _summary_for(markdown)})
    if _in_prompt(kind):
        size = prompt_size(markdown)
        over = size['tokens'] - PROMPT_DOCUMENT_MAX_TOKENS
        if over > 0:
            issues.append({'kind': 'tooManyTokens', 'tokens': size['tokens'], 'limit': PROMPT_DOCUMENT_MAX_TOKENS, 'cut': text_for_tokens(size, over)})
    return issues


_TOP_LEVEL = ('user.md', 'me.md', 'AGENTS.md')
# Files an earlier form of the memory kept: the documents whose text the curation moves elsewhere, and forget.jsonl.
_FORMER_DOCUMENTS = ('profile.md', 'instruction.md')


def _read(directory, file):
    with open(os.path.join(directory, file), encoding='utf-8', newline='') as handle:
        return handle.read()


def _markdown_in(directory, sub):
    target = os.path.join(directory, sub)
    if not os.path.isdir(target):
        return []
    return [sub + '/' + name for name in sorted(os.listdir(target)) if name.endswith('.md') and not name.startswith('.')]


def directory_problems(directory):
    """Everything in a memory folder that breaks the rules, in the order the skills report it.

    Each problem is a dict with the file, the line where there is one, and either an issue of document_issues
    or one of: pageName (with 'issue'), journalFileName, formerDocument, forgetFile, strayFile.
    """
    problems = []

    def check(file, kind):
        if not os.path.isfile(os.path.join(directory, file)):
            return
        for issue in document_issues(kind, _read(directory, file)):
            problems.append(dict(issue, file=file))

    check('user.md', 'user')
    check('me.md', 'me')
    for file in _markdown_in(directory, 'pages'):
        name_issue = page_name_issue(os.path.basename(file)[:-3])
        if name_issue:
            problems.append({'file': file, 'kind': 'pageName', 'issue': name_issue})
        check(file, 'page')
    for file in _markdown_in(directory, 'journal'):
        if _DATE.match(os.path.basename(file)[:-3]):
            check(file, 'journal')
        else:
            problems.append({'file': file, 'kind': 'journalFileName'})
    for file in _FORMER_DOCUMENTS:
        if os.path.exists(os.path.join(directory, file)):
            problems.append({'file': file, 'kind': 'formerDocument'})
    if os.path.exists(os.path.join(directory, 'forget.jsonl')):
        problems.append({'file': 'forget.jsonl', 'kind': 'forgetFile'})
    for stray in sorted(os.listdir(directory)):
        if stray.endswith('.md') and stray not in _FORMER_DOCUMENTS and stray not in _TOP_LEVEL:
            problems.append({'file': stray, 'kind': 'strayFile'})
    return problems


def prompt_sizes(directory):
    """For each document that goes into every prompt, its file and its size, or None when it is missing."""
    sizes = []
    for _, file in PROMPT_DOCUMENTS:
        path = os.path.join(directory, file)
        sizes.append((file, prompt_size(_read(directory, file)) if os.path.isfile(path) else None))
    return sizes
