# Windows のアプリは Microsoft Store では配らず、最初は署名せずに配る

Windows のアプリは、GitHub の Release から NSIS のインストーラーで配る。Microsoft Store(MSIX)では配らない。最初は署名せず、SignPath Foundation のオープンソース向けの無料の署名を申請して、通れば署名する。署名の無いアプリは、SmartScreen の警告の画面を「詳細情報」から「実行」で進めて入れてもらうことになるので、その手順をドキュメントに書く。

## 見送った案

- **Microsoft Store に MSIX で出す。** Store が署名し直すので証明書は要らず、警告も出ない。しかし、2026-09-27 に検証機で ASIST を MSIX にして動かすと、Windows がアプリの AppData への書き込みをパッケージ専用の場所へ振り替えるため、uv が Python を用意できずに失敗した。codex の elevated の sandbox は別のユーザーとしてコマンドを動かすので、同じ理由で ASIST のファイルが見えなくなる。振り替えを止めると動いたが、それには制限つきの権限 `unvirtualizedResources` が要り、Microsoft はこれを主にゲーム向けとしている。個人のアカウントで認められるかは審査に出すまでわからない。さらに、Store の自動更新は、動いている Agent のジョブごとアプリを閉じる。
- **Store に MSI/EXE の形で出す。** いまの NSIS のインストーラーを使えるが、Store の外と同じく自分の証明書が要り、Store に載せる利点が薄い。
- **Azure Artifact Signing。** 個人の開発者は米国とカナダしか使えない。
- **EV 証明書。** 2024 年から、OV 証明書と同じく SmartScreen の警告がすぐには消えなくなった。

## 分かっている制約

- 署名が無いあいだは、SmartScreen の実績がたまらず、版を出すたびに警告が出る。Smart App Control が有効なマシンでは、入れられない。
- SignPath Foundation の署名では、発行元は「SignPath Foundation」と表示される。署名できるのは、公開のリポジトリから CI で自動でビルドしたものだけである。
