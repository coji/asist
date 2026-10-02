# カレンダーは Mac でも Windows でも Google Calendar API だけで読み書きし、macOS の EventKit は使わない

ASIST のカレンダーは、Google カレンダーを使う人に向けて作る。予定は Mac でも Windows でも、利用者がログインした 1 つの Google アカウントから Google Calendar API で読み書きし、macOS の EventKit は使わない。Windows には EventKit にあたる OS の仕組みがないので、Windows でカレンダーを出すには Google Calendar API で作るしかなく、Mac も同じ実装にすれば、画面、文言、モデルへの説明、テストを OS ごとに分けずに済む。EventKit を使うと、macOS の許可が署名に結び付き、シェルから起動したアプリでは許可が効かず、許可の状態を戻すには `tccutil` が要るなど、許可の扱いにも手間がかかっていた。Mac のカレンダーの ID は Google のカレンダーの ID に対応づけられないので、設定を版 6 に上げるときに選んだカレンダーを捨て、連携をオフにする。利用者は Google にログインして、カレンダーを選び直す。

## 見送った案

- **Mac は EventKit のまま、Windows だけ Google Calendar API にする。** iCloud や Exchange のカレンダーも Mac では読めるが、読み書きの実装が 2 つになり、許可の状態、同期の説明、エラーの文言、画面の出し分けを OS ごとに持ち続けることになる。

## 分かっている制約

- Google のアカウントにないカレンダー(iCloud や Exchange など)は、ASIST には出ない。
- `calendar.events` は Google が機密に分ける権限で、Google の審査を通して使っている。同意の画面の設定を変えたり、権限を足したりすると、審査をやり直すことになる。
