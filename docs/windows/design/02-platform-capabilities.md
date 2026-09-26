# OS ごとに使える機能を決めて渡す

## 何を解決するか

いまは、OS で使えない機能も画面に出ていて、押すと失敗します。Windows で初回セットアップを進めたときは、次のようになります。

- **聞き取りの手順。** MLX の Qwen3-ASR を勧め、「準備」を押すと「Apple Silicon の Mac でしか動きません」と出ます。
- **追加の準備の手順(`setup/extras.ts`)。** 3つの準備が自動で始まり、3つとも同じ理由で失敗します。1つずつ「スキップ」を押さないと先に進めません。
- **設定の「声」。** 何も起きない「エコーキャンセル」のスイッチが出ます。
- **カレンダー。** ツールとカードが出たままで、使うとエラーになります。

一方で、OS を判定するコードは7か所に散らばっています(`ipc.ts:180,226`、`mlx-runtime.ts:38`、`vap.ts:184,416`、`onnx-runtime.ts:45`、`native-mic.ts:75`、`calendar.ts:48`)。renderer が知っているのは `qwenTts.recommended` だけです。

## 形

```ts
// src/shared/platform.ts
export type OsFamily = 'macos' | 'windows'

/** The Python environment the local speech recognition and Qwen3-TTS run in on this machine. */
export type SpeechRuntime = 'mlx' | 'cuda'

export interface PlatformCapabilities {
  /** Only for wording that names an OS part (Finder / File Explorer). No feature is gated on it. */
  os: OsFamily
  /** null when this machine cannot run the local models; the reason is shown instead of the choice. */
  speechRuntime:
    | { kind: SpeechRuntime; memoryGb: number }
    | { kind: null; reason: 'unsupported-os' | 'no-nvidia-gpu' | 'driver-too-old' | 'gpu-too-old' }
  /** The echo-cancelling native microphone helper (macOS voice processing). */
  nativeMic: boolean
  /** The Python workers that run on the CPU: the memory search, the aizuchi classifier and MaAI. */
  cpuSidecars: boolean
  calendar: boolean
  /** The accelerator the global hotkey registers; the label is derived from it. */
  hotkey: string
}
```

- 決めるのは main の `src/main/services/platform.ts` です。起動時に1回、OS と CPU と `gpu.ts` の結果から作り、保持します。
- 値から機能を決める部分は、`src/shared/platform.ts` の純粋な関数にします。こうすると、GPU があるときとないとき、ドライバーが古いときの組み合わせを、Mac の上でテストできます。
- renderer へは、新しい IPC の `GetPlatformCapabilities` で渡します。`SetupStatus` に足さないのは、次の理由からです。
  - セットアップ以外の画面(設定、カード、ツールの一覧)も同じ値を使います。
  - 値が起動中に変わりません。
- **`memoryGb` の中身。** MLX では Mac の総メモリー、CUDA では GPU の VRAM です。モデルの推奨(いまの `recommendAsrModel(os.totalmem())` と `recommendQwenTts(...)`)はこの値から決めます。

## 使う側

| 使う場所 | 見る値 | Windows(NVIDIA の GPU あり)でどうなるか |
|---|---|---|
| `brain/tools.ts:261` のカレンダーのツール、`brain/mini-app-tools.ts` の calendar | `calendar` | 登録しない |
| `panels/registry.tsx` のカレンダーのカード、`CalendarSettings`、セットアップと設定の要約、`prompt.ts:190-199` の朝の要約 | `calendar` | 出さない。プロンプトは「カレンダーは未接続」のときと同じにする |
| セットアップの聞き取りの手順、設定のモデル(`ModelsPage`) | `speechRuntime` | CUDA の Qwen3-ASR を出す。GPU が無いマシンでは理由を出し、ブラウザの中の Whisper だけを選べる |
| TTS の選択肢の Qwen3-TTS | `speechRuntime` | 第2段階までは出さない(CUDA の Qwen3-TTS を作ったら出す) |
| 追加の準備(`setup/extras.ts`) | `cpuSidecars` | 記憶の検索、相槌の分類器、MaAI を準備する |
| 設定の「声」のエコーキャンセル | `nativeMic` | 出さない |
| 設定のショートカットの行と文言 | `hotkey` | Windows のショートカットと、その表記を出す |
| ファイルの「Finder で表示」、ログの「Finder で開く」など | `os` | 「エクスプローラーで表示」など |

main の中で OS を判定していた7か所は、`platform.ts` の値を読む形に替えます。

- `mlx-runtime.supported()`、`onnx-runtime` と `vap` の判定、`native-mic.available()`、`calendar.ts` の拒否は、それぞれ `speechRuntime`、`cpuSidecars`、`nativeMic`、`calendar` を読みます。
- `ipc.ts:226` のマイクの許可は、OS ごとの実装に分けます。詳しくは [06-os-integration.md](06-os-integration.md) にあります。

## 保存している設定の移行

設定の `asrModel` は、いまは `'auto' | 'qwen3-asr-1.7b-mlx' | 'whisper-large-v3-turbo-mlx'` です。実行環境の名前が値に入っているので、次のように変えます。

- 保存する値は、`'auto' | 'qwen3-asr-1.7b' | 'whisper-large-v3-turbo'` と、Windows で足すモデル(Qwen3-ASR 0.6B など、[05-speech.md](05-speech.md) で決めます)にします。
- どの実行環境で、どのリポジトリとリビジョンのモデルを使うかは、`src/shared/asr-models.ts` の表から導きます。
- その実行環境で使えないモデルが保存されているときは、エラーにして選び直してもらいます。例えば、Mac から持ってきた設定の Whisper MLX を Windows で使おうとした場合です。

`settings.json` の形が変わるので、AGENTS.md の決まりに従い、次のことを同じ変更の中で行います。

1. バージョンを v3 から v4 に上げます。
2. v3 から v4 への移行を足します(`-mlx` を取り除く)。
3. `tests/fixtures/stored/settings.v4.json` を足します。

## テスト

- `src/shared/platform.ts` の関数を、次の組み合わせで確かめます。
  - macOS arm64
  - macOS x64(対象外)
  - Windows x64 で NVIDIA の GPU がないとき
  - Windows x64 でドライバーが古いとき(580 より前)
  - Windows x64 で GPU が古いとき(compute capability が 7.5 より前、GTX 10 など)
  - Windows x64 で VRAM が 8GB と 16GB のとき
- 使う側のテストでは、いまの `Object.defineProperty(process, 'platform', ...)` で OS を差し替える書き方(`onnx-runtime.test.ts:24`、`native-mic.test.ts:19`、`vap-service.test.ts:29` など)をやめます。代わりに capabilities を差し込む形にします。いまの書き方では、Windows の上で `darwin` のふりをしても `path` は Windows のままなので、期待値が合わなくなります。
- 設定の移行は、`tests/fixtures/stored/settings.v3.json` から v4 へ移すテストで確かめます。
