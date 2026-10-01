# ローカルの音声認識と読み上げは、同梱した llama.cpp と speech.cpp で GPU の上で動かす

macOS でも Windows でも、ローカルの音声認識は Qwen3-ASR(1.7B と 0.6B)の GGUF を llama.cpp の llama-server で動かし、読み上げの Qwen3-TTS(0.6B と 1.7B)と Irodori-TTS は自分で実装した speech.cpp のワーカーで動かす。どちらのプログラムもアプリに同梱し、Mac では Metal で、Windows では Vulkan で GPU を使う。モデルは Hugging Face から、版と sha256 を固定して取得する。Python の実行環境を作らないので、初回の準備はモデルの取得だけで済み、OS ごとに別の推論の実装を保たなくてよい。どの OS でも同じモデルの同じファイルを使うので、聞き取りと声の質が OS で変わらない。Windows では単体の GPU があるマシンでだけ提供し、それ以外のマシンでは理由を出して、ブラウザの中の Whisper と live のエンジンを使ってもらう。

## 見送った案

- **Mac では MLX、Windows では CUDA の torch で動かす。** OS ごとに別の実装と、数 GB の Python の実行環境を保つことになる。Windows では NVIDIA の GPU、ドライバー 580 以上、RTX 20 以降に限られ、Qwen3-TTS は Windows で動かなかった。
- **Qwen3-TTS を qwentts.cpp で動かす。** 文を分けて作った声を聞き比べると、震えるような雑音が乗っていた。Qwen3-TTS の codec は過去の入力だけを見るので、speech.cpp は途中の状態を持ち越して、分けて作っても一度に作った声と同じ波形を出す。
- **llama.cpp の CUDA の版を同梱する。** CUDA 13 の版は RTX 20 の機械語を含まず、ドライバーが対応する CUDA より新しいとき起動に失敗する。CUDA 12 の版は動いたが、最初の起動で GPU のコードのコンパイルに 28 秒かかった。Vulkan はドライバーの版を問わず、下の実測のとおり速さも足りる。
- **Windows の統合 GPU でも動かす。** 測っていない。メモリを CPU と分け合うので、音声認識と読み上げを同時に動かして間に合うかを確かめてから決める。
- **メモリの少ない Mac のために Whisper large-v3-turbo を残す。** Qwen3-ASR 0.6B が 1.8 GB で動くので、選択肢を Qwen3-ASR だけにまとめた。
- **Windows で、sherpa-onnx の日本語のモデル(ReazonSpeech の zipformer)を CPU で動かす。** GPU が要らないが、Mac と違うモデルになり、聞き取りの質を別に調整することになる。

## 実測

2026-09-29、llama.cpp b11246 と qwen3-tts-ggml v0.1.1(speech.cpp の以前の名前)、重みは Q8_0(Qwen3-TTS の codec は F16)。Mac は M5(32 GB)、Windows は RTX 2080(8 GB、ドライバー 591.86)。

| | M5、Metal | RTX 2080、Vulkan |
|---|---|---|
| Qwen3-ASR 1.7B、17 秒の発話 | 1.40 秒、3.4 GB | 0.60〜0.68 秒、VRAM 3.2 GB |
| Qwen3-ASR 0.6B、同じ発話 | 0.58 秒、1.8 GB | 0.36〜0.40 秒、VRAM 1.9 GB |
| Qwen3-TTS 0.6B、最初の声まで、1 秒の声を作る時間 | 0.05 秒、0.35 秒、2.3 GB | 0.07 秒、0.31 秒、VRAM 1.6 GB |
| Qwen3-TTS 1.7B、同じ | 0.08 秒、0.49 秒、3.3 GB | 0.08 秒、0.36 秒、VRAM 2.7 GB |

- 8 GB の RTX 2080 では、デスクトップが使う 1.9 GB と合わせて、音声認識 1.7B と読み上げ 0.6B で 6.7 GB、読み上げを 1.7B にすると 7.7 GB になった。
- Qwen3-ASR 0.6B は「いいえ」を「いや」と聞き、1.7B は聞き違えなかった。
- qwen3-tts-ggml は、F32 の重みでは公式の実装と同じ音声の符号の列を出した。Q8_0 では途中から別の列になるが、聞いて違いは分からなかった。
- Qwen3-TTS 0.6B は、声の前に最大で 1 秒ほどの無音を作ることがあり、1.7B ではほとんど無かった。
- 2026-10-01、speech.cpp v0.3.0 では、M5 で Qwen3-TTS 0.6B が最初の声まで 0.04 秒、1 秒の声を作る時間が 0.37 秒、メモリが 1.8 GB で、1.7B が 0.06 秒、0.47 秒、2.8 GB だった。新しい版を入れたあとの最初の起動は、Metal のカーネルの組み立てで、準備ができるまで 15.6 秒かかった。

## 分かっている制約

- 単体の GPU が無い Windows のマシンでは、ローカルの音声認識と読み上げ(Qwen3-TTS と Irodori-TTS)を使えない。
- 新しい版のアプリや GPU のドライバーを入れたあとの最初の起動では、Mac では Metal のカーネルを、Windows では Vulkan のシェーダーを組み立てるので、その回だけ準備が長くなる。
- 同梱した相槌の音声は Qwen3-TTS 0.6B で作ったもので、1.7B で読み上げるときも同じものを鳴らす。
- speech.cpp は ASIST のために作ったもので、Qwen3-TTS と Irodori-TTS の新しい版には自分で追従する。
