# 参考にした資料

2026-09-27 に確かめたものです。

## 署名と配布

- Azure Artifact Signing の quickstart(個人はアメリカとカナダだけ): https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Azure Artifact Signing の FAQ: https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- SmartScreen の評判の仕組み: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Smart App Control と署名: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control
- uv の署名を求める issue: https://github.com/astral-sh/uv/issues/18967
- electron-builder の Windows の署名: https://www.electron.build/docs/features/code-signing/code-signing-win/
- electron-builder の NSIS: https://www.electron.build/docs/nsis/
- ASAR の検査: https://www.electronjs.org/docs/latest/tutorial/asar-integrity

## git と uv

- MinGit: https://gitforwindows.org/mingit.html
- Git for Windows のリリース: https://github.com/git-for-windows/git/releases
- 長いパス: https://gitforwindows.org/git-cannot-create-a-file-or-directory-with-a-long-path.html
- シンボリックリンク: https://gitforwindows.org/symbolic-links.html
- dugite-native(GitHub Desktop の git): https://github.com/desktop/dugite-native
- uv のインストール: https://docs.astral.sh/uv/getting-started/installation/
- uv の保存場所: https://docs.astral.sh/uv/reference/storage/
- uv と PyTorch: https://docs.astral.sh/uv/guides/integration/pytorch/

## 音声

- Electron で他のプロセスの音を打ち消せない件: https://github.com/electron/electron/issues/47043
- `echoCancellation` の値: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation
- Windows 11 のエコーキャンセルの API: https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/windows-11-apis-for-audio-processing-objects
- Qwen3-ASR: https://github.com/QwenLM/Qwen3-ASR 、https://arxiv.org/abs/2601.21337
- Qwen3-ASR(transformers 用): https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf
- Qwen3-ASR の GGUF: https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS
- faster-qwen3-tts: https://github.com/andimarafioti/faster-qwen3-tts
- PyTorch のリリースと CUDA: https://github.com/pytorch/pytorch/blob/main/RELEASE.md
- CUDA 12.6 の wheel の終わり: https://dev-discuss.pytorch.org/t/notice-cuda-12-6-wheels-will-no-longer-be-published-from-pytorch-2-15-drops-maxwell-pascal-volta/3432
- CUDA のドライバーの対応: https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html
- MLX のインストール(CUDA): https://ml-explore.github.io/mlx/build/html/install.html
- sherpa-onnx の Qwen3-ASR: https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/index.html

## プロセスと Electron

- Node の CVE-2024-27980(`.cmd` の起動): https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
- Node の child_process: https://nodejs.org/api/child_process.html
- Claude Code のインストール: https://code.claude.com/docs/en/setup
- Codex の Windows の sandbox: https://learn.chatgpt.com/docs/windows/windows-sandbox
- safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- safeStorage の同期の API の廃止: https://github.com/electron/electron/pull/53662
- 通知: https://www.electronjs.org/docs/latest/tutorial/notifications
- systemPreferences: https://www.electronjs.org/docs/latest/api/system-preferences

## CI

- GitHub の runner のイメージ: https://github.com/actions/runner-images
- windows-2025 に D ドライブが無い件: https://github.com/actions/runner-images/issues/12416

## Mac の上で試して確かめたこと

- MinGit の zip の中身とハッシュ(`MinGit-2.55.0.5-64-bit.zip`)
- uv の Windows の zip の中身とハッシュ(0.12.18)
- electron-builder 26.16.1 の Windows のビルドの手順(`node_modules` のソースと、Electron 43.1.0 の win32 の zip で試した)
- Windows 向けの lock のコンパイル(`uv pip compile --python-platform x86_64-pc-windows-msvc`)
- Git for Windows の `/dev/null` と `GIT_CONFIG_NOSYSTEM` の扱い(v2.55.0.windows.5 のソース)
