# 音声: マイク、聞き取り、読み上げ

## 最初に Windows で使えるもの

| 部分 | macOS(いま) | Windows(最初に出すもの) |
|---|---|---|
| マイク | ネイティブのヘルパー(voice processing)。失敗すると getUserMedia | getUserMedia(Chromium のエコーキャンセル)を正式な経路にする |
| 聞き取り(サーバー) | MLX の Qwen3-ASR 1.7B 8bit / Whisper large-v3-turbo | **CUDA の torch で動く Qwen3-ASR 1.7B か 0.6B**(NVIDIA の GPU があるとき) |
| 聞き取り(ブラウザの中) | Whisper small(Transformers.js) | 同じ |
| live のエンジン | GPT-Live、Gemini Live | 同じ |
| 読み上げ | VOICEVOX、AivisSpeech、Qwen3-TTS(MLX)、システムの声 | VOICEVOX、AivisSpeech、システムの声。Qwen3-TTS は第2段階 |
| 相槌の分類器、記憶の検索、MaAI | CPU の Python worker | 同じ(CPU)。Core i9-9900K で準備と実行を確かめました(下の実測) |

## 聞き取り: Windows の Qwen3-ASR

### 仕組み

いまの Mac の worker(`resources/mlx_asr_worker.py`)とのやりとりは、次のとおりです。

- **起動と準備。** 起動の引数はモデルのフォルダとリビジョンです。モデルを読み終えると `ASIST_JSON:{"type":"ready"}` を出します。
- **要求。** 要求は `{id, wavPath, language}` の1行です。`wavPath` は、`asr-transcriptions` が userData の `asr-temp` に書いた 16kHz、モノラル、16bit の WAV です。
- **答え。** `{"type":"result", id, text}` か `{"type":"error", id, error}` を、1つずつ順番に返します。
- **ストリーミングはしない。** 話している途中の結果も、溜まった音声をそのつど頭から認識し直しています。

Windows の worker(`resources/cuda_asr_worker.py`)は、このやりとりをそのまま使います。違うのは、中で使うライブラリとモデルだけです。

### 使うもの(2026-09-27 に確かめた値)

- **ライブラリ。** transformers 5.17.0 にあるネイティブの Qwen3-ASR を使います(v5.13.0 から入っています)。
  - 公式の `qwen-asr` パッケージは使いません。理由は2つあります。
    - gradio、flask、sox、nagisa など、推論に使わない依存を90個引き込みます。
    - `import qwen_asr` をしただけで、nagisa とそのネイティブの依存(dyNET38)が読み込まれます。
  - transformers のネイティブの実装なら、依存は35個、torch を除いて 46 MB です。
- **torch。**
  - 使うのは `torch 2.14.0+cu130` です。PyPI の Windows の torch は CPU だけなので、download.pytorch.org の cu130 を使います。
  - cu130 を選ぶ理由は、RTX 20 から RTX 50 まで(compute capability 7.5〜12.0)を1つで扱えるからです。cu126 は RTX 50 を扱えず、torch 2.15 で無くなります。
- **モデル。** Apache-2.0、BF16 です。リビジョンを固定します。

| モデル | リビジョン | 大きさ | VRAM(RTX 2080、fp16 で実測) |
|---|---|---|---|
| `Qwen/Qwen3-ASR-1.7B-hf` | `bcd2b5b7f32b480ab5790554cfa8347f246a14f3` | 4.08 GB | 3.9 GB(確保は 4.1 GB) |
| `Qwen/Qwen3-ASR-0.6B-hf` | `7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c` | 1.57 GB | 1.6 GB |

- **VRAM の測り方。** 2026-09-27 に、torch 2.14.0+cu130 と transformers 5.17.0 で測りました。CUDA のコンテキストが、これとは別に約 0.5 GB を使います。
- **設定の値。** 設定には、実行環境に依らないモデルの名前(`qwen3-asr-1.7b` など)を保存します。どの実行環境でどのリポジトリを使うかは `asr-models.ts` の表で決めます。
- **Whisper は出さない。** CUDA の worker は Qwen3-ASR しか動かさないので、CUDA の実行環境では Whisper を選べません。
- **その実行環境に無いモデルが保存されているとき。** Mac の設定の Whisper を Windows で読んだときなどです。別のモデルに差し替えず、そのモデルを「使えない」と表示して、選び直してもらいます。差し替えると、利用者の知らないうちに聞き取りの質が変わり、選んでいない数 GB のモデルをダウンロードすることになるためです。`auto` は、その実行環境の推奨に決まるので、この問題は起きません。

- **精度。** Mac のモデル(MLX の 8bit)より、Windows のモデル(BF16)のほうが量子化しない分だけ精度が高いはずです。同じ Qwen3-ASR なので、日本語の聞き取りの傾向は揃います。

### worker の中身

```python
from transformers import AutoProcessor, AutoModelForMultimodalLM
processor = AutoProcessor.from_pretrained(snapshot)
model = AutoModelForMultimodalLM.from_pretrained(snapshot, dtype=dtype).to("cuda").eval()
# 要求ごと
pcm = <WAV を float32 の 16kHz に>
inputs = processor.apply_transcription_request(audio=pcm, language=request["language"]).to(model.device, model.dtype)
with torch.inference_mode():
    out = model.generate(**inputs, max_new_tokens=256, do_sample=False)
text = processor.decode(out[:, inputs["input_ids"].shape[1]:], return_format="transcription_only")[0]
```

- **言語の渡し方。** `language` は、いまの `ASR_LANGUAGE_NAMES`(`asr-models.ts`)の英語の名前をそのまま渡せます。
- **起動時の確かめ。** `ready` を出す前に、次のことを確かめます。
  - `torch.cuda.is_available()`
  - `get_device_capability` が 7.5 以上であること
  - 満たさなければ、理由を付けて `fatal` を出します。
  - VRAM の空きは先に確かめません。足りなければモデルを読むところで失敗し、`fatal` になります。先に確かめるなら、しきい値を M5-5 の実測で決めます。
- **型の選び方。** compute capability が 8.0 以上なら bf16 を、7.5(RTX 20)なら fp16 を使います。RTX 2080 の fp16 は fp32 と同じ文字を返したので、RTX 20 も対象にします(実測は ADR 0021)。
- **Mac での確かめ方。** 開発のときだけ、同じ worker を Mac の CPU(float32)で動かせます。MPS では動かしません。
  - 2026-09-27 に、Apple M5 の Mac の CPU で 0.6B を動かしました。4.0 秒の音声に約 1.0 秒、2.5 秒の音声に約 0.5 秒かかり、起動は約 2 秒でした。
  - `say -v Kyoko` の「今日の東京の天気を教えて。」はそのまま書き起こせました。「歯医者の予約」は「配車の予約」になりました。

### lock ファイル

- **ファイル。** `resources/cuda-speech-requirements.txt` は、Windows だけの lock です。
- **torch の書き方。** torch は、ハッシュ付きの直接の URL で書きます。

  ```
  transformers==5.17.0
  numpy
  torch @ https://download.pytorch.org/whl/cu130/torch-2.14.0%2Bcu130-cp312-cp312-win_amd64.whl#sha256=6a20371bf5af2af933a6149e5ec13f7ea7ad506276137dae9386f98d236c02ff
  ```

- **コンパイル。** `uv pip compile --only-binary :all: --generate-hashes --python-version 3.12 --python-platform x86_64-pc-windows-msvc` でコンパイルします。できたファイルは、いまの `installRequirements`(`--require-hashes -r`)でそのままインストールできます。Mac の上で、`--dry-run` で確かめました。
- **使わない書き方。** `--extra-index-url` をファイルに書くのはやめます。uv が numpy や jinja2 まで PyTorch の入手先から取ってしまうためです。
- **ダウンロードの大きさ。** 合わせて約 2.04 GB(torch が 1.99 GB、ほかの 34 個が 46 MB)です。これにモデルの 1.58 GB(0.6B)か 4.09 GB(1.7B)が加わります。
  - セットアップの聞き取りの手順は、実行環境とモデルのうちまだ無い分の大きさを出します(M5-6)。何も無いときは、1.7B で約 6.1 GB、0.6B で約 3.6 GB です。
  - Mac の MLX の lock は約 0.13 GB なので、Mac の同じ表示は、Qwen3-ASR で約 2.6 GB、Whisper で約 1.8 GB です(それまでは固定の「2GB ほど」でした)。
  - 大きさは 2026-09-27 に、PyPI と download.pytorch.org が lock の wheel について返す大きさと、Hugging Face の API が固定したリビジョンについて返す大きさを足して求めました。uv が一度だけ取得する Python は含みません。

### 実行環境(`speech-runtime.ts`)

- **環境を作る場所と中身。**
  - `speech-runtime.ts` は、capabilities が示す実行環境の値を読み、その環境を作って worker を動かします。
  - macOS では `userData/mlx-audio-runtime` に環境を作り、その環境で ASR の worker と Qwen3-TTS の worker を動かします。
  - Windows では `userData/cuda-speech-runtime` に環境を作り、ASR の worker だけを動かします。`cuda` の表を足し、Windows のアプリに worker と lock を入れました(M5-6)。Windows の実機ではまだ動かしていません。

  | | `mlx` | `cuda` |
  |---|---|---|
  | 使える条件 | macOS arm64 | Windows x64、NVIDIA、ドライバー 580 以上、compute capability 7.5 以上 |
  | 環境のフォルダ | `userData/mlx-audio-runtime` | `userData/cuda-speech-runtime` |
  | lock | `mlx-audio-requirements.txt` | `cuda-speech-requirements.txt` |
  | ASR の worker | `mlx_asr_worker.py` | `cuda_asr_worker.py` |
  | TTS の worker | `qwen_tts_worker.py` | 第2段階 |
  | モデルの表 | `mlx-community/Qwen3-ASR-1.7B-8bit` など | `Qwen/Qwen3-ASR-1.7B-hf` など |

- **共通のまま使える処理。** Hugging Face の固定したリビジョンの取得(`hf_snapshot.py`)と、「全部のファイルがそろったら入ったとみなす」判定(`modelInstalled`)は、そのまま使えます。
  - Windows の huggingface_hub は、シンボリックリンクを作れないとき、`snapshots` にファイルを写します。そのため、この判定は動きます。
  - ダウンロードの進み具合は、`blobs` のファイルに加えて、`snapshots` の中のリンクでない普通のファイルも数えます。huggingface_hub は、リンクを作れないときにダウンロードを終えたファイルを `blobs` から `snapshots` へ移すので(1.29 の `_create_symlink` で確かめました)、`blobs` だけを数えると、ファイルが1つ終わるたびに進み具合が戻るためです。
- **モデルの置き場所。**
  - main が `~/.cache/huggingface/hub` に決め、ダウンロードと worker の Python に `HF_HUB_CACHE` で渡します(M5-1)。
  - この場所は huggingface_hub の既定と同じです。Windows の既定も `%USERPROFILE%\.cache\huggingface\hub` なので、同じ組み立てで合います。
  - 渡す理由は、ASIST を起動した環境に `HF_HOME` や `HF_HUB_CACHE` があると、Python がそちらにダウンロードし、main が見に行く場所と食い違うためです。
  - `HF_HOME` は渡しません。渡すと、`hf auth login` で保存したトークンの場所まで変わるためです。

### GPU を調べる(`gpu.ts`)

- **調べ方。** `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits` を起動します。
- **調べる時。** main が起動したときに1回だけ、capabilities を決めるところで起動します(M5-6)。そのため、ドライバーや GPU を替えたときは、ASIST を起動し直すと反映されます。「ドライバーが古い」の文も、更新してから起動し直すように書いています。
- **場所。** `nvidia-smi.exe` は、いまのドライバーでは `C:\Windows\System32` にあります。
- **無いときや失敗したとき。** 見つからないときや失敗したときは、capabilities の `speechRuntime` を「NVIDIA の GPU が無い」にします。理由は、セットアップの聞き取りの手順、設定の「声」のモデルの行、「モデル」の音声認識のカードに出ます。
- **使えないときの理由。** ドライバーのバージョンが 580 より前なら「ドライバーが古い」、compute capability が 7.5 より前なら「GPU が古い」にします。
- **モデルの推奨。** VRAM が 6 GB 以上なら 1.7B を、それより少なければ 0.6B を勧めます。1.7B は、上の実測の 4.1 GB と CUDA のコンテキストの 0.5 GB を合わせると、対象で最も小さい 4 GB の GPU(GTX 1650 など)に収まりません。6 GB の GPU なら、デスクトップとほかのアプリに約 1.4 GB が残ります。
- **2回目の確かめ。** worker も起動時に同じことを確かめ、違えば `fatal` にします。ドライバーを入れ替えた直後などに、2つの結果が食い違うことがあるためです。

### MLX の CUDA を試した結果

MLX の Windows 向けの CUDA の wheel(`mlx-cuda-13` 0.32.2)と `mlx-audio==0.4.7` は入り、GPU も見えました。しかし、最初の GPU の計算で 0xC06D007E(遅延読み込みの DLL が見つからない)で落ち、CUDA の DLL のフォルダを足しても同じでした(2026-09-27)。そのため、transformers の案にしました(ADR 0021)。

## マイクとエコーキャンセル

- **いまの動き。**
  - いまは、ネイティブのヘルパーが使えないとき(Windows では常に)、renderer が getUserMedia に切り替えます(`VoiceController.ts:428-441`、`LiveVoice.ts:76-86`)。
  - このとき、エコーキャンセル、ノイズの抑制、自動のゲインは有効です(`MicCapture.ts:134-141`)。
  - 読み上げ中に話し始めたと判定するしきい値も、3倍に上げています(`VoiceController.ts:199-206`)。
- **Chromium のエコーキャンセル(Electron 43 の既定)の限界。**
  - Chromium 自身が鳴らした音しか打ち消しません。
  - ASIST の読み上げは、VOICEVOX、Qwen3-TTS、live のエンジンのどれも、renderer の `<audio>` を通して鳴らしています(`SpeechPlayer.ts:43-50`)。そのため、これらは打ち消されるはずです。
  - システムの声(Web Speech)は Windows の音声合成が鳴らすので、打ち消されない見込みです。
- **ほかのプロセスの音も打ち消す方法。**
  - Chromium 150(Electron 43)では、`echoCancellation: "all"` を指定できます。
  - Windows 11 では、システム全体の出力を参照にして、ほかのプロセスの音も打ち消します(既定で有効、遅延が 170ms 増えます)。
  - Electron のビルドでこれが有効かは未確認です。
- **決め方(M5-7)。** スピーカーで次の4つを試します。
  - VOICEVOX
  - live のエンジン
  - システムの声
  - `"all"` を指定したとき

  読み上げ中に自分の声を拾い直さないかを確かめ、結果から Windows の既定を決めます。システムの声だけが拾い直すなら、Windows ではシステムの声のときに `"all"` を使うか、システムの声を選べなくするかを決めます。
- **fallback との関係。**
  - いまの「ネイティブのヘルパーが使えないと getUserMedia に切り替える」動きは、AGENTS.md の「fallback を足さない」とぶつかります。
  - Windows では、capabilities の `nativeMic` が `false` なので、最初から getUserMedia を使う形にします。そうすれば、切り替えを「失敗したときの代わり」ではなく「その OS の経路」として扱えます(M5-8)。
  - macOS で、ヘルパーが動いている最中に落ちたときの切り替えを残すかどうかは、Windows の対応とは別に決めます([06-open-questions.md](../06-open-questions.md))。

## 読み上げ

- **VOICEVOX と AivisSpeech。**
  - Windows では、どちらのアプリも electron-builder の NSIS のインストーラーで入ります(VOICEVOX は `build/electronBuilderConfig.ts`、AivisSpeech は `electron-builder.config.cjs`)。インストーラーは、利用者ごとに入れるときは `%LOCALAPPDATA%\Programs\<アプリ名>`、全員に入れるときは `%ProgramFiles%\<アプリ名>` を既定にします。エンジンは、その下の `vv-engine\run.exe` と `AivisSpeech-Engine\run.exe` です。
  - ASIST は、この2か所を自動起動の候補にしました(M5-10)。これは配布の設定と electron-builder の既定から読み取ったもので、実際に入れたマシンではまだ確かめていません([06-open-questions.md](../06-open-questions.md))。
  - インストール先を利用者が変えたときは、ASIST にはその場所が分かりません。そのときは、利用者がアプリを起動しておけば、アプリが起動したエンジンに ASIST がつなぎます。画面の案内もそう書いています。
  - 起動は `detached: true` なので、`windowsHide: true` も付けます(M1-11)。
- **システムの声。** Windows の音声(SAPI と OneCore)で動きます。
- **Qwen3-TTS(第2段階)。**
  - 公式の `qwen-tts` をそのまま使うと、RTX 4060 で実時間の 0.23 倍しか出ません(音声1秒に約4秒かかります)。
  - CUDA graph を使う `faster-qwen3-tts` 0.5.2 なら、次の速さが報告されています。
    - RTX 4060: 0.6B で 2.26 倍、最初の音まで 413ms
    - RTX 4060: 1.7B で 1.83 倍
  - `faster-qwen3-tts` は transformers 5 の上で動きます。聞き取りと同じ環境(`cuda-speech-runtime`)に入れられることを、uv で解決して確かめました(65 パッケージ)。
  - worker は、いまの `qwen_tts_worker.py` と同じやりとり(`ready`、`chunk`、`end`、`error`、`fatal`、`cancel`)にできます。
  - 話者と言語の一覧は、MLX のモデルと同じです。
  - ただし、話す速さの指定が無いので、別の処理が要ります。

## CPU の Python worker(記憶の検索、相槌の分類器、MaAI)

- **作り。** どれも CPU で動く作りで、macOS に固有だったのは、動く条件の判定、venv の Python の場所、lock ファイルの3つでした。[04-bundled-tools.md](04-bundled-tools.md) の手当て(`venvPython`、`PYTHONUTF8`、`os.nice`、lock ファイル)をして、3つとも Windows で動きました。動く条件の判定は、どの OS でも動くので無くしました。
- **MaAI の時間。** MaAI の推論は、80ms のフレームあたり、Apple Silicon で 31ms、Windows の Core i9-9900K で中央値 59.8ms です。どちらも 80ms に収まります。
- **Windows での実測(2026-09-27)。** Windows 11、Core i9-9900K(8スレッド)で、ASIST のコード(`npm run dev`)から、アプリの IPC を通して準備しました。準備の時間は、約 1.5MB/s の回線でのダウンロードを含みます。
  - 準備の時間は、相槌の分類器が58秒、記憶の検索が59秒、MaAI が171秒でした。
  - MaAI の worker は CPU で起動しました(`worker ready (cpu, 12.5Hz)`)。12秒の音声を実時間で流すと、80ms のフレームあたりの推論は、中央値 59.8ms、90パーセンタイル 63.8ms、最大 66.7ms でした。
