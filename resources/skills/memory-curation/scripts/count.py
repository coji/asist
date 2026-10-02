"""Counts what each file that goes into every conversation costs there, against its limit.
Usage: <skill>/uv run --no-project <skill>/scripts/count.py <memoryDir>

Prints one line per file and the exit code is 1 when a file is over its limit. The count is the one ASIST
makes before it merges a curation and when the user saves on the memory screen. The English skill ships the
same script with its lines written in English.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# UTF-8 and \n whatever the code page and the line ending of the system, as the Agent and the tests read them.
sys.stdout.reconfigure(encoding='utf-8', newline='\n')

from memory_format import PROMPT_DOCUMENT_MAX_TOKENS, prompt_sizes, text_for_tokens  # noqa: E402

over = False
for file, size in prompt_sizes(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')):
    if size is None:
        print(f'{file}: ありません')
        continue
    left = PROMPT_DOCUMENT_MAX_TOKENS - size['tokens']
    counted = f"{file}: {size['tokens']} / {PROMPT_DOCUMENT_MAX_TOKENS} トークン"
    if left >= 0:
        print(f"{counted}(残り {left}。この書きぶりで約 {text_for_tokens(size, left)['characters']} 字)")
    else:
        over = True
        print(f"{counted}({-left} 超過。この書きぶりで約 {text_for_tokens(size, -left)['characters']} 字を削る)")
if over:
    print('超えているファイルを縮めて、もう一度実行してください。')
    sys.exit(1)
print('OK')
