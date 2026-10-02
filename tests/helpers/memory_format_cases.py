"""Answers the cases of tests/fixtures/memory-format-cases.json with the curation's memory_format.py.

Usage: uv run --no-project memory_format_cases.py <cases.json> <folder of memory_format.py>
Prints, as JSON, every case whose answer differs from the one the fixture expects, so an empty list means
the Python rules answer as ASIST's TypeScript ones do.
"""

import json
import sys

# UTF-8 and \n whatever the code page and the line ending of the system, as the Agent and the tests read them.
sys.stdout.reconfigure(encoding='utf-8', newline='\n')
sys.path.insert(0, sys.argv[2])

from memory_format import document_issues, page_name_issue, prompt_size, token_estimate  # noqa: E402

with open(sys.argv[1], encoding='utf-8') as file:
    cases = json.load(file)

differences = []


def compare(group, name, expected, actual):
    if expected != actual:
        differences.append({'group': group, 'name': name, 'expected': expected, 'actual': actual})


for case in cases['tokens']:
    compare('tokens', case['name'], case['tokens'], token_estimate(case['text']))
for case in cases['prompts']:
    compare('prompts', case['name'], case['size'], prompt_size(case['markdown']))
for case in cases['documents']:
    compare('documents', case['name'], case['issues'], document_issues(case['kind'], case['markdown']))
for case in cases['pageNames']:
    compare('pageNames', case['name'], case['issue'], page_name_issue(case['name']))
print(json.dumps(differences, ensure_ascii=False))
