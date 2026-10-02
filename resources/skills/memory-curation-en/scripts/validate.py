"""Checks a memory folder. Usage: uv run --no-project validate.py <memoryDir>

Every problem is printed on its own line and the exit code is 1; with none it prints OK. The rules come from
memory_format.py, two folders up, which ASIST applies as well when it merges a curation. The Japanese skill
ships the same check with its problems written in Japanese.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# UTF-8 and \n whatever the code page and the line ending of the system, as the Agent and the tests read them.
sys.stdout.reconfigure(encoding='utf-8', newline='\n')

from memory_format import SECTION_MAX_CHARS, directory_problems  # noqa: E402

MESSAGES = {
    'frontmatterMissing': lambda p: 'there is no frontmatter',
    'frontmatterUnclosed': lambda p: 'the frontmatter is not closed (there is only one ---)',
    'obsoleteKey': lambda p: f"{p['key']} in the frontmatter is no longer used; delete it",
    'aliasesOnlyOnPages': lambda p: 'aliases belong only on the pages under pages/; delete it',
    'updatedNotDate': lambda p: 'updated must be a date in the form YYYY-MM-DD',
    'titleMissing': lambda p: 'there is no "# name" line',
    'noHeadings': lambda p: (
        'there is not one "## heading" (a journal entry is divided by ## into its subjects)'
        if p['file'].startswith('journal/') else 'there is not one "## heading"'
    ),
    'duplicateHeading': lambda p: f"the heading \"{p['heading']}\" is also on line {p['first']}; merge the two into one",
    'headingWithoutText': lambda p: f"there is nothing under the heading \"{p['heading']}\" (delete a heading you have nothing to write under)",
    'sectionTooLong': lambda p: f"the heading \"{p['heading']}\" holds {p['length']} characters (keep it to {SECTION_MAX_CHARS})",
    'firstHeading': lambda p: f"make the first heading \"{p['heading']}\" (it is what gets read when the name comes up in the conversation)",
    'tooManyTokens': lambda p: f"it comes to {p['tokens']} tokens (keep it to {p['limit']}: cut about {p['cut']['words']} words, and check with count.py)",
    'pageName': lambda p: (
        'the page name holds a character a file name cannot (/ \\ : * ? " < > |); rename the page'
        if p['issue'] == 'characters' else 'Windows does not allow this name for a file; rename the page'
    ),
    'journalFileName': lambda p: 'the file name must be YYYY-MM-DD.md',
    'formerDocument': lambda p: 'it is no longer used; move what it holds into user.md and me.md, then delete it',
    'forgetFile': lambda p: 'it is no longer used; delete it',
    'strayFile': lambda p: 'this is in the wrong place (a person, a place or a subject belongs in pages/, a record in journal/)',
}

problems = directory_problems(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.'))
for problem in problems:
    place = f"{problem['file']}:{problem['line']}" if 'line' in problem else problem['file']
    print(f"{place}: {MESSAGES[problem['kind']](problem)}")
if problems:
    sys.exit(1)
print('OK')
