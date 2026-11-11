# 集中タイマー

集中と休憩を交互に繰り返すタイマーです。初期値は50分・10分で、時間はそれぞれ1～180分に設定できます。

## iPhone・iPadで通知を使う

1. [集中タイマー](https://harahettarou.github.io/study-interval-timer/)をSafariで開き、共有メニューから「ホーム画面に追加」します。
2. ホーム画面のアイコンから開き、「通知をオン」を押して通知を許可します。
3. 「テスト通知」で届くことを確認して、タイマーをスタートします。通知の設定を変えるときは、先にタイマーをリセットしてください。

## 公開構成

GitHub Pagesは `main` ブランチの `/docs` を公開します。Cloudflare Workersの `TimerSession` が端末ごとの次回切り替えを予約し、Web Pushで通知します。ログインは不要です。通知の予約には、端末の通知先とタイマー設定が必要です。

再デプロイ時は `wrangler.jsonc` の公開URLと `docs/app.js` の通知サーバーURLを確認します。Workerには `VAPID_PUBLIC_KEY`（Base64URL形式のP-256公開鍵）と `VAPID_PRIVATE_KEY`（P-256秘密鍵のJWK JSON）を設定します。秘密鍵はWorkerのシークレットとして管理します。既存の通知登録を維持するため、デプロイ間で同じ鍵を使います。
