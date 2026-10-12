# diet-os

## ChatGPTからの毎朝のプラン登録（POST）

Supabase Edge Function `daily-plan-publish` に、ChatGPTが決定したプランを投稿できます。
アプリ側はプラン表示と「やった / やっていない」等の実績記録を担当します。

### 初期設定（ユーザー本人）

1. GitHub Pages 上の Diet OS にログインします。
2. 「ChatGPT API」タブの「ChatGPT プラン自動登録（POST）」から「投稿用トークンを発行」を押します。
3. 「接続情報をコピー」を押し、その内容をChatGPTのチャットへ送信して定期実行に設定します。
4. このトークンは再表示されません。紛失時は再発行します。再発行・無効化は読み取り用APIを変更しません。

### エンドポイント

`POST https://dygzsficwncawfkyuvoy.supabase.co/functions/v1/daily-plan-publish`

ヘッダー（実際のトークンをコードやGitHubにコミットしないこと）:

```
Content-Type: application/json
X-Plan-Token: <投稿用トークン>
```

JSON例:

```json
{
  "date": "2026-10-13",
  "title": "今日のプラン",
  "summary": "日々の実績・ユーザー設定を踏まえた方針",
  "items": [
    { "category": "food", "title": "朝食", "detail": "たんぱく質のある朝食をとる" },
    { "category": "cardio", "title": "ウォーキング", "detail": "20分間、会話できる強度で歩く" }
  ]
}
```

category は `food / strength / cardio / steps / sleep / recovery / other` のいずれか。
プランは当日の `daily_plans` にupsertされ、`daily_plan_items` に未完了（pending）として登録されます。
既存プランの項目に完了・スキップがある場合は、実績を消さないためHTTP 409で投稿を拒否します。

### ChatGPT定期実行からのHTTP POST

ChatGPTのSupabase接続を利用し、Supabaseの `pg_net` 拡張の `net.http_post` を呼び出します。
送信する際のSQL例（認証情報を公開しないこと）:

```sql
select net.http_post(
  url := 'https://dygzsficwncawfkyuvoy.supabase.co/functions/v1/daily-plan-publish',
  body := '{"date":"2026-10-13","title":"今日のプラン","summary":"例","items":[{"category":"steps","title":"散歩","detail":"30分歩く"}]}'::jsonb,
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'X-Plan-Token','<投稿用トークン>'
  ),
  timeout_milliseconds := 15000
) as request_id;
```

上記は非同期送信です。返却された `request_id` について、次のSQLで成功（HTTP 201）を必ず検証します。

```sql
select id, status_code, content, error_msg
from net._http_response
where id = <request_id>;
```

レスポンスが未到着の場合は少し後に再確認します。成功の確認なしに登録済みとは通知しません。

### セキュリティ

- 読み取り専用トークンはPOSTでは使えません。 `api_tokens.scopes.plan_write = true` の専用トークンのみ許可します。
- ユーザー自身がログインした画面でSHA-256ハッシュを発行・保存し、サーバーにはトークン原文を保存しません。
- トークンで指定できる対象ユーザーは本人のみです。
- 「投稿権限を無効化」でトークンを失効できます。
- アプリのフロントエンド・GitHubには投稿用トークンを埋め込まないでください。


## メール・パスワードで毎回ログインして投稿する方式（オプション）

既存の `daily-plan` Edge Function は、Supabase Authで取得したJWTのBearer認証に対応しています。
専用投稿トークンを使わない場合は `scripts/publish-daily-plan.mjs` を利用できます。

**重要:** 元のDiet OSは `signInAnonymously()` を採用していました。匿名ユーザーのままではメール・パスワードで再ログインできません。
アプリの「自動投稿用のログイン設定」で、**現在の匿名アカウント**にメールを連携 → 確認メールを承認 → パスワードを設定してください。
メール連携にはSupabase DashboardのAuth設定でManual Identity Linkingの有効化が必要な場合があります。別ユーザーを新規作成すると現在の記録が別のユーザーIDになり、元のデータにアクセスできなくなります。

### 認証APIの処理

1. `POST /auth/v1/token?grant_type=password` へメール・パスワードを送信し、`access_token` を得ます。
2. `POST /functions/v1/daily-plan` に `Authorization: Bearer <access_token>` を添えて当日のプランJSONを送ります。
3. HTTP 201と `ok: true` / `plan_id` を検証します。失敗したら登録完了扱いにしません。

アプリにはアクセストークンの固定値を埋め込みません。Supabase Authが発行する短期トークンを送信の都度取得します。

### スクリプト実行

```sh
# すべての環境変数は安全なsecret storeから注入します。
# DIET_OS_EMAIL          ログインメールアドレス
# DIET_OS_PASSWORD       ログインパスワード
# SUPABASE_PUBLISHABLE_KEY プロジェクトのpublishable key（公開可能）
# DIET_OS_USER_ID        任意。誤ったアカウントへの投稿を防止するためのユーザーID

node scripts/publish-daily-plan.mjs ./daily-plan.json
```

`daily-plan.json` はChatGPTがその日のログやユーザー設定を参考に作成したプランJSONです。生成済みJSONを標準入力で渡すこともできます。
**スクリプトはChatGPTのプラン作成を代行しません**。自動で動作させるには、秘密情報ストアを利用できるスケジューラー/実行環境に組み込む必要があります。

ChatGPTの定期実行で使用する場合も、ログイン情報を自動タスクのプロンプトに平文で書き込まないでください。継続的なSupabaseへの接続権限と、安全な認証情報の取得手段が必要です。
