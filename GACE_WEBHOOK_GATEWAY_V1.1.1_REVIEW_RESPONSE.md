# G-ACE Universal Webhook Gateway v1.1.1 — レビュー反映回答

## 結論

v1.1.0 に対して受け取ったレビューのうち、Gateway本体に反映すべき内容を v1.1.1 として取り込みました。

反映済み:

1. Dockerコンテナを専用非特権ユーザー `appuser` で実行
2. UID/GIDを `10001:10001` に固定
3. Compose側にも `user: "10001:10001"` を明示
4. `no-new-privileges:true` を追加
5. `cap_drop: ALL` を追加
6. 署名検証テストを 9件へ拡張
7. README / SECURITY / IMPLEMENTATION_NOTES にセキュリティ反映内容を追記

## 重要な整理

レビューで提示された FastAPI + SQLite のReceiver実装は、独立Gateway本体ではなく、下流アプリ側の受信サンプルとして扱います。

Gateway本体は以下の構成を正本とします。

```text
Node.js / TypeScript / Express / PostgreSQL / Redis / BullMQ / Docker Compose
```

## 未完了の検証

以下は今後のE2E対象です。

1. Docker Compose E2E
2. Postgres停止 -> emergency spool -> DB復旧 -> import
3. Redis停止 -> delivery queued保持 -> Redis復旧 -> re-enqueue
4. Worker停止 -> stale delivering復旧
5. Downstream冪等ReceiverとのE2E
6. Provider実Webhook受信テスト
