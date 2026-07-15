# Operations Runbook

## 起動

```bash
cp .env.example .env
npm install
npm run secret
# .env を実値へ変更
docker compose up -d --build
```

## 状態確認

```bash
docker compose ps
docker compose logs -f api
docker compose logs -f worker
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

## イベント確認

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "http://127.0.0.1:7373/admin/events?limit=20" | jq .
```

## 再実行

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  "http://127.0.0.1:7373/admin/events/<event_id>/replay" | jq .
```

## 事故時の確認順

### 署名エラー

1. Provider側Secretと `.env` のSecretが一致しているか。
2. Providerが正しい `/ingress/:slug` に送っているか。
3. reverse proxyがbodyを変形していないか。
4. timestampが許容秒数を超えていないか。

### 配送失敗

1. `docker compose logs -f worker`
2. DBの `deliveries.last_error` を確認
3. `DEST_*_URL` がWorkerコンテナから到達可能か確認
4. Downstreamが2xxを返しているか確認
5. 修復後にreplay

### Spool確認

```bash
docker compose exec api sh -lc 'ls -la /spool'
docker compose logs -f worker | grep -i spool
```

## バックアップ

Postgresが正本です。

```bash
docker compose exec postgres pg_dump -U webhook webhook_gateway > backup.sql
```
