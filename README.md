# Solo Podcast Broadcast Desk

一人で話すポッドキャストを、配信画面のような見た目で収録するための Web アプリです。

## 機能

- ブラウザ音声認識によるリアルタイム文字起こし
- Gemini で自動生成される YouTube Live / Twitch 風コメント
- そのまま画面録画しやすい配信レイアウト
- マイク音声のローカル録音とダウンロード

## 起動

```bash
npm install
npm run dev
```

`GEMINI_API_KEY` または `GOOGLE_API_KEY` を環境変数に設定しておく必要があります。

## 使い方

1. `http://localhost:5173` を開く
2. マイク許可後に `音声認識を始める`
3. 必要なら `マイク録音を開始`
4. macOS の画面収録や OBS でこの画面全体を録画

Chrome 系ブラウザでは Web Speech API が動きやすいです。
