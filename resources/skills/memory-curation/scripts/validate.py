"""Checks a memory folder. Usage: uv run --no-project validate.py <memoryDir>

Every problem is printed on its own line and the exit code is 1; with none it prints OK. The rules come from
memory_format.py, two folders up, which ASIST applies as well when it merges a curation. The English skill
ships the same check with its problems written in English.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.stdout.reconfigure(encoding='utf-8')

from memory_format import SECTION_MAX_CHARS, directory_problems  # noqa: E402

MESSAGES = {
    'frontmatterMissing': lambda p: 'frontmatter がありません',
    'frontmatterUnclosed': lambda p: 'frontmatter が閉じていません(--- が一つしかありません)',
    'obsoleteKey': lambda p: f"frontmatter の {p['key']} は使わないので消してください",
    'aliasesOnlyOnPages': lambda p: 'aliases は pages/ のページにだけ書きます。消してください',
    'updatedNotDate': lambda p: 'updated は YYYY-MM-DD の日付にしてください',
    'titleMissing': lambda p: '「# 名前」の見出しがありません',
    'noHeadings': lambda p: (
        '「## 見出し」が一つもありません(日記は話題ごとに ## で区切ってください)'
        if p['file'].startswith('journal/') else '「## 見出し」が一つもありません'
    ),
    'duplicateHeading': lambda p: f"見出し「{p['heading']}」が {p['first']} 行目にもあります。同じ見出しは一つにまとめてください",
    'headingWithoutText': lambda p: f"見出し「{p['heading']}」の下に本文がありません(書くことが無い見出しは消してください)",
    'sectionTooLong': lambda p: f"見出し「{p['heading']}」の本文が {p['length']} 字あります({SECTION_MAX_CHARS} 字までにしてください)",
    'firstHeading': lambda p: f"最初の見出しは「{p['heading']}」にしてください(名前が会話に出たとき、ここが読まれます)",
    'tooManyTokens': lambda p: f"{p['tokens']} トークンあります({p['limit']} までにしてください。約 {p['cut']['characters']} 字を削り、count.py で確かめます)",
    'pageName': lambda p: (
        'ページの名前に使えない文字があります(/ \\ : * ? " < > | は使えません)。名前を変えてください'
        if p['issue'] == 'characters' else 'この名前は Windows でファイルの名前に使えません。名前を変えてください'
    ),
    'journalFileName': lambda p: 'ファイル名は YYYY-MM-DD.md にしてください',
    'formerDocument': lambda p: '使わないので、中身を user.md と me.md に移してから消してください',
    'forgetFile': lambda p: '使わないので消してください',
    'strayFile': lambda p: '置く場所が違います(人や場所や物事は pages/、記録は journal/ に置いてください)',
}

problems = directory_problems(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.'))
for problem in problems:
    place = f"{problem['file']}:{problem['line']}" if 'line' in problem else problem['file']
    print(f"{place}: {MESSAGES[problem['kind']](problem)}")
if problems:
    sys.exit(1)
print('OK')
