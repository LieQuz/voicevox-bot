# voicevox-bot 改善提案・機能追加アイデア

リポジトリ全体をレビューし、修正すると良い点と追加すると便利そうな機能をまとめました。
対象: `src/index.ts`（約1150行）、`package.json`、`README.md`、`.env.example`、`tsconfig.json`

---

## 1. 修正すると良い点（バグ・信頼性）

### 優先度: 高

#### 1-1. VOICEVOX への fetch にタイムアウトがない
- 該当: `synthesizeVoice()`（`src/index.ts` 646-675行）、`fetchVoicevoxSpeakers()`（678-704行）
- 現状: `fetch` にタイムアウト指定がなく、VOICEVOX Engine がハングした場合にリクエストが永久に待ち続ける。
- 影響: `processQueue()` の `state.processing` が `true` のまま戻らず、**それ以降の読み上げが全て停止**する。
- 対策: `AbortSignal.timeout(10_000)` などを `fetch` の `signal` に渡す。

#### 1-2. `/join` の応答が3秒制限を超過する可能性
- 該当: `joinCommand()`（490-543行）
- 現状: `members.fetch()` と `entersState(connection, Ready, 30_000)` を `interaction.reply()` 前に `await` している。Discord のインタラクション応答は **3秒以内** が必須のため、接続に時間がかかると「Unknown interaction」で応答に失敗する。
- 対策: ハンドラ冒頭で `await interaction.deferReply({ ephemeral: true })` し、完了後に `editReply` する。

#### 1-3. `/join` で接続失敗時にコネクションが残る
- 該当: `joinCommand()`（520-527行）
- 現状: `entersState` が失敗（タイムアウト等）した場合の `try/catch` がなく、例外がそのまま投げられて `joinVoiceChannel()` で作られたコネクションが破棄されずに残る。`autoJoinVoiceChannel()`（570-574行）では `connection.destroy()` しているので、そちらと揃える。
- 対策: `try/catch` で失敗時に `connection.destroy()` + エラー応答。

#### 1-4. インタラクションハンドラ全体にエラーハンドリングがない
- 該当: `client.on("interactionCreate", ...)`（208-414行）
- 現状: コマンド処理中の予期しない例外が未捕捉で、ユーザーに応答が返らない（「アプリケーションが応答しませんでした」になる）。
- 対策: ハンドラ全体を `try/catch` で包み、失敗時は `replyPrivate` でエラー通知する。`voiceStateUpdate` / `messageCreate` 内の `await`（`notifyTextChannel` 等）も同様。

#### 1-5. グレースフルシャットダウンがない
- 現状: `SIGINT` / `SIGTERM` のハンドラがなく、systemd からの停止時に VC 接続の破棄・DB クローズ・一時ファイル削除が行われない。
- 対策: `process.on("SIGTERM", ...)` 等で全 `guildStates` の `disconnectGuildInternal()`、`db.close()`、`client.destroy()` を実行してから終了する。

### 優先度: 中

#### 1-6. 話者ID `0` が選択できない
- 該当: セレクトメニュー処理（220行）の `speaker <= 0` チェック
- 現状: VOICEVOX には style id `0`（四国めたん あまあま）が存在するが、バリデーションで弾かれてしまう。プルダウンには表示されるのに選択するとエラーになる。
- 対策: `speaker < 0` に修正する。

#### 1-7. ギルドのデフォルト話者を変更する手段がない
- 該当: `GuildState.speaker`（92行）
- 現状: 参加時に `defaultSpeaker`（環境変数）で初期化されるだけで、更新するコマンドがない。話者未設定ユーザーのフォールバック（197、467、477行）として使われるため、実質「サーバーの標準の声」を変えられない。
- 対策: 管理者向けに `/default-speaker` のようなコマンドを追加し、DB（`guild_settings`）に保存する。

#### 1-8. `joinCommand()` 内のデッドコード
- 該当: 514-519行の `refreshedState` チェック
- 現状: 499行目の `guildStates.get()` から514行目までの間に、既存stateが残る経路では `await` が挟まれない（destroyed 分岐では削除済みで return せず抜けるのみ）。結果としてこのブロックは実質到達不能。
- 対策: 削除してシンプルにする。

#### 1-9. 切断時に `AudioPlayer` を明示停止していない
- 該当: `disconnectGuildInternal()`（1064-1076行）
- 現状: `connection.destroy()` のみで `player.stop()` を呼んでいない。また `processQueue()` の `finally`（639行）と二重で `cleanupTempFile` が走り、ENOENT のエラーログが出る可能性がある。
- 対策: `state.player.stop(true)` を追加し、一時ファイルの二重削除を整理する。

#### 1-10. キュー長・レート制限がない
- 現状: `state.queue` は無制限で、短時間に大量投稿されると読み上げが際限なく溜まる。VOICEVOX への合成リクエストも無制限。
- 対策: キュー上限（例: 50件）とユーザーごとの読み上げレート制限を設け、超過時はテキストチャンネルに通知する。

### 優先度: 低

#### 1-11. 読み上げテキスト変換の未対応パターン
- 該当: `normalizeForSpeech()`（1098-1134行）
- チャンネルメンション `<#123>` / ロールメンション `<@&123>` / タイムスタンプ `<t:...>` が生文字列のまま読まれる。
- スポイラー `||...||` がそのまま読まれる（「ネタバレを含むメッセージ」等に置換する選択肢）。
- コードブロック ` ``` ` が全文読まれる（「コードブロックが投稿されました」等に置換が親切）。
- スタンプのみのメッセージは `content` が空で添付もないため完全に無視される（「スタンプが投稿されました」と読む選択肢）。

#### 1-12. 入退室アナウンスの表示名が未正規化
- 該当: 469、478行
- 現状: `displayName` をそのまま読み上げテキストに使うため、名前に絵文字や特殊文字を含むユーザーだと不自然に読まれる。辞書（`applyPronunciationRules`）も適用されない。
- 対策: 表示名にも絵文字変換・辞書適用を通す。

#### 1-13. 絵文字が英語 shortcode 名で読まれる
- 該当: 1126行の `nodeEmoji.unemojify`
- 現状: 😂 → `:joy:` → 「ジョイ」のように英語名で読まれる。
- 対策: よく使う絵文字の日本語名マップを用意する（完全な網羅は難しいので主要絵文字のみでも可）。

#### 1-14. `package.json` に `engines` 指定がない
- 現状: Node 20+ 前提（グローバル `fetch` 等）だが、README にしか書かれていない。
- 対策: `"engines": { "node": ">=20" }` を追加する。

#### 1-15. `.gitignore` の DB ファイル指定が限定的
- 現状: `data/*.sqlite3` のみ。`*.sqlite3-journal` / `*.sqlite3-wal` / `*.sqlite3-shm` などの SQLite 付随ファイルが対象外。
- 対策: `data/` ディレクトリごと無視するか、付随ファイルパターンを追加する。

---

## 2. 追加すると便利そうな機能

### コマンド系

| 機能 | 内容 |
|---|---|
| `/skip` | チャットの `s` と同等のスキップをスラッシュコマンド化（`s` を知らないユーザー向け） |
| `/speed` | ユーザーごとの話速設定（0.5〜2.0）。現在 `DEFAULT_SPEED_SCALE` が全員共通で固定（660行）なので、`user_speakers` テーブルに速度カラムを追加して永続化 |
| `/volume` | 音量調整。`createAudioResource(filePath, { inlineVolume: true })` + `resource.volume.setVolume()` で実現可能 |
| `/status` | VOICEVOX Engine 疎通確認・稼働時間・キュー件数・現在の接続先を表示。障害時の切り分けが楽になる |
| `/default-speaker` | サーバーの標準話者を変更（管理者向け）。1-7 の対応 |
| `/announce` | 入退室アナウンス（参加/退出の読み上げ）の ON/OFF。現在は無条件で読み上げられる（469、478行） |
| `/dict export` / `/dict import` | 読み替え辞書のエクスポート/インポート（CSV/JSON）。サーバー移行や共有に便利 |
| `/speaker` の現在値表示 | 選択前に現在の自分の話者を表示、または `/speaker reset` でデフォルトに戻す |

### 読み上げ処理系

- **長文の分割読み上げ**: 現在は120文字で静かに切り捨て（1133行）。分割して複数キューに入れるか、切り捨て時に「以下省略」と読む。
- **読み上げ除外プレフィックス**: `!` や `;` で始まるメッセージは読み上げない（他Botへのコマンド入力が読まれてしまう問題の対策）。
- **スレッド対応**: 現在は `message.channel.id !== state.textChannelId` でスレッド内メッセージが読まれない（182行）。親チャンネルIDも判定対象にする選択肢。
- **複数読み上げチャンネル**: 1ギルド1チャンネルのみ対応の現状を拡張。
- **ユーザー別読み上げミュート**: 特定ユーザーのメッセージを読み上げない設定（管理者向け）。
- **自動参加チャンネルの限定**: 現在はギルド内のどのVCでも自動参加する（418-433行）。特定VCのみ自動参加する設定があると運用しやすい。

### 運用・インフラ系

- **起動時ヘルスチェック**: Bot 起動時に VOICEVOX Engine へ `/version` を打って疎通確認し、失敗時は警告ログを出す。
- **合成失敗時の通知**: 連続して合成に失敗した場合にテキストチャンネルへ「VOICEVOX に接続できません」等を通知（現在は `console.error` のみで、利用者が気付けない）。
- **Docker Compose 化**: README は VOICEVOX Engine の `docker run` のみ。Bot 本体も含めた `docker-compose.yml` があると導入が一発で終わる。
- **構造化ログ**: `console.log/error` のみの現状から、pino 等でログレベル・タイムスタンプ付きにする。`journalctl` での追跡が楽になる。

---

## 3. 開発環境・コード構造の改善

- **ファイル分割**: 全機能が `src/index.ts` 1ファイルに集中。`commands/`（スラッシュコマンド定義・ハンドラ）、`voice/`（接続・キュー・合成）、`db/`（SQLite アクセス）、`text/`（`normalizeForSpeech` 等）への分割で見通しが大きく改善する。
- **Lint / Formatter**: ESLint + Prettier が未導入。`npm run lint` / `format` スクリプトを追加。
- **テスト**: テスト基盤がない。`normalizeForSpeech` や `applyPronunciationRules`、`buildSpeakerPickerComponents` は純粋関数に近く、Vitest 等でテストしやすい。
- **CI**: GitHub Actions で `build`（型チェック）+ `lint` を回すワークフローを追加。
- **一時ファイルをやめてストリーミング再生**: 現在は合成ごとに WAV をディスクへ書き込み（`saveTempWav`、1040-1047行）。`createAudioResource(Readable.from(buffer))` でメモリ上の Buffer から直接再生でき、ディスク I/O と一時ファイル管理（`cleanupTempFile` の二重削除問題含む）を丸ごと削減できる。
- **`.env.example` にコメント追加**: 各変数の意味・必須/任意をコメントで補足。

---

## 4. おすすめの取り組み順

1. **まず直したい（信頼性に直結）**: 1-1（fetch タイムアウト）、1-2 / 1-3（`/join` の応答・失敗処理）、1-4（エラーハンドリング）、1-5（シャットダウン処理）
2. **次に効果が大きい**: 1-6（話者ID 0）、1-10（キュー上限）、2 の `/skip`・`/speed`・`/status`、合成失敗時の通知
3. **余裕ができたら**: ファイル分割・Lint/CI 整備・ストリーミング再生・1-11 の読み上げ変換強化
