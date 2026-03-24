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

ローカル開発では Vite が `/api` を `http://localhost:8787` にプロキシします。

## 使い方

1. `http://localhost:5173` を開く
2. マイク許可後に `音声認識と録音を開始`
3. 停止するときは同じボタンで `音声認識と録音を停止`
4. macOS の画面収録や OBS でこの画面全体を録画

Chrome 系ブラウザでは Web Speech API が動きやすいです。

## Vercel デプロイ

このリポジトリは Vercel の Serverless Functions に対応しています。

1. Vercel にプロジェクトを接続
2. Build Command を `npm run build` に設定
3. Output Directory を `dist` に設定
4. 環境変数 `GEMINI_API_KEY` または `GOOGLE_API_KEY` を登録

本番では `api/commentary.mjs` が `/api/commentary` として動作します。
