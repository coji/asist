# Windows では x64 と NVIDIA の GPU を前提にし、ローカルの音声認識は Qwen3-ASR を CUDA の torch で動かす

Windows で対象にするのは x64 だけにする。ローカルの音声認識は、NVIDIA の GPU(compute capability 7.5 以上、ドライバー 580 以上)があるマシンでだけ提供し、macOS と同じ Qwen3-ASR を、transformers のネイティブの実装と CUDA の torch(2.14.0+cu130)で動かす。GPU が無いマシンでは、ローカルの音声認識の選択肢を出さずに理由を表示し、ブラウザの中の Whisper と live のエンジンを使ってもらう。macOS と同じモデルを使えば、日本語の聞き取りの質が OS で変わらない。cu130 は RTX 20 から RTX 50 までを一つの torch で扱える。型は compute capability 8.0 以上で bf16、7.5(RTX 20)で fp16 にする。

## 見送った案

- **MLX の CUDA のバックエンドで、macOS の worker とモデルをそのまま使う。** Windows 向けの wheel(`mlx-cuda-13` 0.32.2)は入り、GPU も見えたが、最初の GPU の計算で 0xC06D007E(遅延読み込みの DLL が見つからない)で落ちた。CUDA の DLL のフォルダを足しても同じだった。MLX の公式の説明でも、CUDA のバックエンドは Linux だけである。
- **CPU で動かす。** 下の実測のとおり、話している途中の結果が間に合わない。
- **sherpa-onnx の日本語のモデル(ReazonSpeech の zipformer)で CPU で動かす。** GPU が要らない利点はあるが、macOS と違うモデルになり、聞き取りの質を別に調整することになる。
- **faster-whisper(CTranslate2)。** Whisper は、macOS でも Qwen3-ASR より下の選択肢として置いている。
- **公式の `qwen-asr` パッケージ。** 推論に使わない依存を90個引き込み、import しただけで nagisa とそのネイティブの依存を読み込む。
- **Arm64 の Windows も対象にする。** CUDA の torch の wheel が無い。

## 実測

2026-09-27、Windows 11、RTX 2080(8 GB、compute capability 7.5、ドライバー 591.86)、torch 2.14.0+cu130、transformers 5.17.0。Windows の音声合成(Haruka)で作った日本語の 16kHz の WAV を、読み込んだあとに2回目から測った。

| モデルと型 | VRAM(確保の最大) | 読み込み | 2.4 秒の発話 | 6.5 秒 | 15.6 秒 |
|---|---|---|---|---|---|
| 0.6B fp16 | 1.6 GB | 3.3 秒 | 0.60 秒 | 1.59 秒 | 2.78 秒 |
| 0.6B fp32 | 3.1 GB | 3.3 秒 | 0.44 秒 | 1.38 秒 | 2.52 秒 |
| 1.7B fp16 | 3.9 GB | 6.4 秒 | 0.51 秒 | 1.53 秒 | 2.82 秒 |
| 1.7B fp32 | 7.8 GB | 9.8 秒 | 1.62 秒 | 5.44 秒 | 11.23 秒 |
| 0.6B fp32、CPU(Core i9-9900K) | - | - | 1.20 秒 | 3.92 秒 | 6.86 秒 |

- fp16 と fp32 は、どのモデルでも同じ文字を返した。RTX 20 の fp16 で精度は崩れなかった。
- 1.7B の fp32 は 8 GB を使い切り、4倍ほど遅くなった。1.7B は fp16 で 8 GB の GPU に収まる。
- 1.7B は 0.6B より句読点を多く打った。読み違いは、どちらも同じ1か所(「家を出る」を「顔出る」)だった。
- torch と依存のダウンロードは 2.04 GB(torch が 1.99 GB)、モデルは 0.6B が 1.57 GB、1.7B が 4.08 GB。

## 分かっている制約

- GPU のドライバーが 580 より古いマシンと、RTX 10 以前の GPU では、ローカルの音声認識を使えない。
- 初回の準備で、torch とモデルを合わせて 3.6〜6.1 GB をダウンロードする。
