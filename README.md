# voicevox-bot

`discord.js` + VOICEVOX Engine で動く Discord 読み上げ Bot です。  
自宅サーバー（Ubuntu）へデプロイしやすい手順を中心に書いています。

## できること

- `/join`: 実行者がいるボイスチャンネルへ参加
- `/leave`: ボイスチャンネルから退出
- `/speaker id:<id>`: 自分の話者IDを変更（永続化）
- `/speakers`: 話者一覧を見やすく表示
- `/help`: コマンド一覧 + 主要話者一覧（先頭8件）を表示
- `/join` を実行したテキストチャンネルの通常メッセージを読み上げ
- ユーザーメンション（`<@...>`）は数字IDではなく表示名に変換して読み上げ
- 文頭が `@` の場合は `アット` と読ませる
- 画像/動画など添付付き投稿は `メディアが投稿されました` を読み上げ
- 読み上げ対象チャンネルで `s` と送信すると、現在の読み上げを停止し、溜まっている読み上げキューも全てキャンセル
- 絵文字は読み上げ用に名前へ変換（サーバーカスタム絵文字は名前、通常絵文字は英語shortcode名）
- `w` / `ｗ` は読み上げ時に正規化（単体は `わら`、2文字以上は `わらわら`）
- ユーザーごとの話者IDを SQLite に永続保存（Bot再起動後も維持）
- VCの人間メンバーが0人になると自動で退出
- BotのDiscordステータスに `/help / /join / /speaker 3` の操作ヒントを表示
- コマンド応答は全て ephemeral（実行者のみ表示）

## 事前準備（Discord側）

1. Discord Developer Portal で Bot を作成
2. Bot の Token を発行
3. **Privileged Gateway Intents** で以下を有効化
   - `MESSAGE CONTENT INTENT`
   - `SERVER MEMBERS INTENT`（推奨）
4. Bot をサーバーに招待（OAuth2 scope に `bot` と `applications.commands` を含める）

## Ubuntuサーバーへ導入

### 1) 必要パッケージ

```bash
sudo apt update
sudo apt install -y curl git ffmpeg ca-certificates
```

### 2) Node.js 20+ を入れる（NodeSource）

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 3) Docker を入れる（VOICEVOX Engine 用）

```bash
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

> `usermod` 後は一度ログアウト/ログインしてください。

### 4) プロジェクト配置

```bash
git clone <YOUR_REPO_URL> voicevox-bot
cd voicevox-bot
npm install
```

### 5) 環境変数設定

```bash
cp .env.example .env
```

`.env` を編集:

```dotenv
DISCORD_TOKEN=あなたのBotトークン
DISCORD_GUILD_ID=あなたのサーバーID # 任意: 指定時はスラッシュコマンドを即時反映
VOICEVOX_BASE_URL=http://127.0.0.1:50021
DEFAULT_SPEAKER=1
DEFAULT_SPEED_SCALE=1.2
SPEAKER_CACHE_TTL_MS=300000
```

`!speaker <id>` は「実行したユーザー自身」の設定を保存します。  
保存先DB: `data/voicevox-bot.sqlite3`

## VOICEVOX Engine 起動（Docker）

```bash
docker pull voicevox/voicevox_engine:cpu-latest
docker run -d --name voicevox-engine -p 50021:50021 voicevox/voicevox_engine:cpu-latest
```

疎通確認:

```bash
curl http://127.0.0.1:50021/version
```

## Bot起動

```bash
npm run build
npm run start
```

## systemd で常駐化（推奨）

`/etc/systemd/system/voicevox-bot.service` を作成:

```ini
[Unit]
Description=VOICEVOX Discord Bot
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/voicevox-bot
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

反映:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now voicevox-bot
sudo systemctl status voicevox-bot
```

ログ確認:

```bash
journalctl -u voicevox-bot -f
```

## 運用コマンド

- Bot再起動: `sudo systemctl restart voicevox-bot`
- Bot停止: `sudo systemctl stop voicevox-bot`
- VOICEVOX再起動: `docker restart voicevox-engine`
- VOICEVOXログ: `docker logs -f voicevox-engine`

## よくあるトラブル

- 読み上げされない  
  VOICEVOXのポート公開を確認: `docker ps` で `0.0.0.0:50021->50021/tcp`

- `TokenInvalid`  
  `.env` の `DISCORD_TOKEN` を再確認

- `/help` で話者一覧が出ない  
  `VOICEVOX_BASE_URL` と Engine 稼働状態を確認

- スラッシュコマンドが表示されない  
  Botを再起動し、招待URLに `applications.commands` があるか確認。即時反映したい場合は `.env` に `DISCORD_GUILD_ID` を設定
