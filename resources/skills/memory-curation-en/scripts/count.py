"""Counts what each file that goes into every conversation costs there, against its limit.
Usage: uv run --no-project count.py <memoryDir>

Prints one line per file and the exit code is 1 when a file is over its limit. The count is the one ASIST
makes before it merges a curation and when the user saves on the memory screen. The Japanese skill ships the
same script with its lines written in Japanese.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# UTF-8 and \n whatever the code page and the line ending of the system, as the Agent and the tests read them.
sys.stdout.reconfigure(encoding='utf-8', newline='\n')

from memory_format import PROMPT_DOCUMENT_MAX_TOKENS, prompt_sizes, text_for_tokens  # noqa: E402


def amount(text):
    """An amount of the file's own text, in the units a writer of any of the languages can cut by."""
    return f"about {text['words']} words ({text['characters']} characters without spaces)"


over = False
for file, size in prompt_sizes(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')):
    if size is None:
        print(f'{file}: missing')
        continue
    left = PROMPT_DOCUMENT_MAX_TOKENS - size['tokens']
    counted = f"{file}: {size['tokens']} of {PROMPT_DOCUMENT_MAX_TOKENS} tokens"
    if left >= 0:
        print(f"{counted} ({left} left, {amount(text_for_tokens(size, left))} as this file is written)")
    else:
        over = True
        print(f"{counted} ({-left} over: cut {amount(text_for_tokens(size, -left))} as this file is written)")
if over:
    print('Shorten the files that are over, then run this again.')
    sys.exit(1)
print('OK')
