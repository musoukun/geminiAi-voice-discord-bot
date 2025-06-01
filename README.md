# VOICEVOX × Gemini Discord Bot

DiscordのボイスチャットでGemini AIとVOICEVOXを使って読み上げができるジェミニです。

## 機能

- `/vv` コマンド：テキストをVOICEVOXの音声で読み上げ
- `/vvai` コマンド：AIに質問し、その回答をVOICEVOXの音声で読み上げ
- `/vvlisten` コマンド：ボイスチャットでの会話を認識し、「ジェミニ」と話しかけるとAIが応答
- `/vvstoplisten` コマンド：音声認識を停止
- `/lvv` コマンド：ジェミニをボイスチャンネルから退出させる

## セットアップ

### 前提条件

1. [Node.js](https://nodejs.org/) (v16以上)
2. [VOICEVOX](https://voicevox.hiroshiba.jp/) (インストールして起動しておく)
3. Discord Botのトークン
4. Google API Key (Gemini API)

### インストール

1. このリポジトリをクローンまたはダウンロード
2. `install_dependencies.bat` を実行して必要なパッケージをインストール
3. `src/config.json` ファイルを作成し、以下の形式で設定：

```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN",
  "applicationId": "YOUR_DISCORD_APPLICATION_ID",
  "guildId": "YOUR_DISCORD_SERVER_ID",
  "googleApiKey": "YOUR_GOOGLE_API_KEY"
}
```

### 起動方法

```bash
node src/index.js
```

## 使い方

### テキスト読み上げ

```
/vv text:こんにちは、VOICEVOXです。
```

### AIに質問

```
/vvai question:今日の天気を教えて
```

### 音声認識開始

```
/vvlisten
```

ボイスチャンネルに入った状態でこのコマンドを実行すると、音声認識が開始されます。
その後、「ジェミニ」と話しかけると、AIが応答します。

例：「ジェミニ、今日の天気を教えて」

### 音声認識停止

```
/vvstoplisten
```

## 注意事項

- VOICEVOXはローカルで実行され、ポート50021で接続されるため、起動しておく必要があります
- 音声認識には最新のWhisper AIモデルを使用しています
- 初回の音声認識時にWhisperモデルがダウンロードされるため、少し時間がかかることがあります
- 長時間の音声認識はリソースを消費するため、使用しないときは `/vvstoplisten` で停止することをおすすめします

## 音声認識について

このボットは、OpenAIのWhisperモデル（小型版）を使用した高精度な音声認識を実装しています。
- Transformersライブラリを使用して、ブラウザ環境でも動作するように最適化されています
- 多言語対応（主に日本語用に設定）
- 雑音に強く、自然な会話を認識できます
- 初回実行時にモデルがダウンロードされるため、インターネット接続が必要です

## ライセンス

MIT License 
