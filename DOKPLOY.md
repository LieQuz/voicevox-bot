# Dokploy + VOICEVOX GPU デプロイ手順

このリポジトリには、Dokploy の **Compose サービス**としてそのままデプロイできる
`Dockerfile` / `docker-compose.yml` / `.dockerignore` が含まれています。

構成:

```text
Dokploy (Docker Compose)
├─ bot      : このリポジトリからビルド（Node 22）
│   └─ /app/data ← bot_data ボリューム（SQLite）
└─ voicevox : voicevox/voicevox_engine:nvidia-latest
    └─ Compose内部ネットワークのみ（50021は外部公開しない）
```

Bot は Discord へ外向きに接続するだけなので、**ドメイン設定は不要**です。

## 1. 前提条件（GPUホスト）

- Ubuntu 22.04 / 24.04（x86_64 推奨）
- NVIDIA GPU + ドライバ
- `nvidia-container-toolkit`
- Dokploy がインストール済み
- Docker が GPU を認識できること

ドライバとツールキットの導入例:

```bash
# NVIDIAドライバ（環境に合わせて読み替えてください）
sudo ubuntu-drivers autoinstall
sudo reboot

# NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

確認:

```bash
nvidia-smi

docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

Dokploy を別サーバーで動かしている場合は、**実際に Compose を動かすサーバー**に
上記を導入してください。

## 2. Dokploy で Compose サービスを作成

1. Dokploy でプロジェクトを作成
2. `Create Service` → `Compose` を選択
3. Git リポジトリ・ブランチを指定
4. Compose Path に `docker-compose.yml` を指定
5. 環境変数を設定（下記）
6. デプロイ

### 環境変数

最低限必要なのは `DISCORD_TOKEN` です。

```dotenv
DISCORD_TOKEN=あなたのBotトークン
DISCORD_GUILD_ID=
DEFAULT_SPEAKER=1
DEFAULT_SPEED_SCALE=1.2
VOICEVOX_INTONATION_SCALE=1.0
VOICEVOX_PITCH_SCALE=0
VOICEVOX_PAUSE_LENGTH_SCALE=1.0
VOICEVOX_PREWARM_LIMIT=2
VOICEVOX_STREAMING_SYNTHESIS=true
```

- `DISCORD_GUILD_ID`: 指定するとスラッシュコマンドが即時反映されます
- `VOICEVOX_INTONATION_SCALE`: `1.1〜1.2` で抑揚を豊かにできます
- `DEFAULT_SPEED_SCALE`: 自然さ重視なら `1.0〜1.1`
- `VOICEVOX_PAUSE_LENGTH_SCALE`: 読点の間の長さ（`0.9〜1.0`）
- `VOICEVOX_PREWARM_LIMIT`: 起動時に先読みする話者数
  - VRAM 8GB: `2` 前後を推奨
  - VRAM 12GB以上: `4` 前後
  - VRAM 6GB以下: `1` または `0`
  - `0` で先読み無効（デフォルト話者のみ必要なら `1`）
- `VOICEVOX_STREAMING_SYNTHESIS=false`: ストリーミング再生を無効化

### ドメイン・ポート

- **ドメインは設定しない**
- `docker-compose.yml` に `ports` を追加しない
- VOICEVOX は `http://voicevox:50021` で Bot からだけアクセス

## 3. 動作確認

Dokploy のログ画面、またはサーバー上で:

```bash
docker compose ps
docker compose logs -f voicevox
docker compose logs -f bot
```

VOICEVOX の疎通確認（Bot コンテナ内から）:

```bash
docker compose exec bot node -e \
  "fetch('http://voicevox:50021/version').then(r => r.text()).then(console.log)"
```

GPU が使われているか確認:

```bash
docker compose exec voicevox nvidia-smi
```

`nvidia-smi` がイメージ内にない場合は、ホスト側で `nvidia-smi` を実行し、
VOICEVOX のログに CUDA / GPU 関連のエラーが出ていないことを確認してください。

## 4. データの永続化とバックアップ

SQLite は `bot_data` ボリュームの `/app/data/voicevox-bot.sqlite3` に保存されます。
再デプロイしても保持されますが、定期的にバックアップしてください。

```bash
# ボリューム名を確認
docker volume ls

# バックアップ例（<project>_bot_data の部分は実際の名前に置き換え）
docker run --rm \
  -v <project>_bot_data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/voicevox-bot-data-$(date +%F).tgz -C /data .'
```

## 5. 更新

- Git に push すると Dokploy の自動デプロイで Bot イメージが再ビルドされます
- VOICEVOX を更新したい場合はイメージタグを変更して再デプロイ
- 本番では `nvidia-latest` より `nvidia-0.xx.x` のように**バージョン固定**を推奨

## 6. より自然な声を試す（VOICEVOX NEMO）

現行の VOICEVOX 音声よりナレーション寄りで自然に感じる場合がある、公式の別音声ライブラリ
**VOICEVOX NEMO** も API 互換で利用できます。

- イメージ: `voicevox/voicevox_nemo_engine:nvidia-latest`
- エンジン 0.26.0 ベース（`/streaming_synthesis` 対応）
- 女声1〜6 / 男声1〜3 の9声（キャラクター声ではありません）
- 利用時は NEMO の規約・クレジット表記を確認してください

試す場合は、`docker-compose.yml` の `voicevox` サービスだけを次のように変更します。

```yaml
  voicevox:
    image: voicevox/voicevox_nemo_engine:nvidia-latest
    restart: unless-stopped
    environment:
      VV_PORT: "50021"          # NEMOのデフォルトは50121
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
```

`VOICEVOX_BASE_URL` は `http://voicevox:50021` のままで動きます。
再デプロイ後、`/speaker` の一覧に NEMO の声が表示されます。

元のキャラクター音声に戻す場合は、イメージを
`voicevox/voicevox_engine:nvidia-latest` に戻して再デプロイしてください。

> `nvidia-0.27.0-dev` などの開発版は新機能を含みますが、本番運用にはおすすめしません。

## 7. 注意点

- **Bot は1レプリカのみ**で運用してください（SQLite と Discord セッションの都合）
- VOICEVOX GPU 版は VRAM を多く使います。`CUDA out of memory` が出る場合は
  `VOICEVOX_PREWARM_LIMIT` を下げてください
- 複数GPUから選びたい場合は `docker-compose.yml` の `count: 1` を
  `device_ids: ["0"]` などに変更してください
- VOICEVOX の 50021 番ポートをインターネットへ公開しないでください
- Bot の再起動時は `SIGTERM` を受けて DB を閉じ、VC から退出します
  （`stop_grace_period: 30s` 設定済み）

## 8. トラブルシューティング

### `could not select device driver "" with capabilities: [[gpu]]`

`nvidia-container-toolkit` が Docker に設定されていません。

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker info | grep -i nvidia
```

### `nvidia-smi` が失敗する

NVIDIA ドライバが入っていないか、GPU が見えていません。ホスト側で確認してください。

### VOICEVOX が healthy にならない

```bash
docker compose logs voicevox
```

- CUDA / ドライバのバージョン不一致
- VRAM 不足
- イメージのアーキテクチャ不一致（ARMサーバーでは動作しない場合があります）

`start_period` を延ばすか、GPU 設定を見直してください。

### Bot から `voicevox` に接続できない

- 2つのサービスが同じ Compose プロジェクト内にあるか
- サービス名が `voicevox` のままか
- `VOICEVOX_BASE_URL=http://voicevox:50021` になっているか

### `DISCORD_TOKEN is required`

Dokploy の環境変数に `DISCORD_TOKEN` を設定してください。

### SQLite への書き込み権限エラー

既存ボリュームが root 所有になっている場合は、一度だけ権限を修正します。

```bash
docker compose exec -u root bot chown -R node:node /app/data
```
