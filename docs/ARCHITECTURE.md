# Architecture

## 結論

G-ACE Universal Webhook Gateway は、外部Webhookをアプリ本体へ直接刺さず、独立した共通入口で受信・検証・保存・配送・復旧をまとめる基盤です。

```text
Provider
  -> Gateway API
  -> PostgreSQL event ledger
  -> Redis / BullMQ delivery queue
  -> Worker
  -> Internal applications
```

## 設計原則

1. 署名検証前にpayloadを信用しない。
2. raw bodyを保持してProvider仕様通りに検証する。
3. Postgresを正本、Redisを配送路として分離する。
4. 配送は at-least-once とし、Downstreamで冪等化する。
5. 外部署名と内部配送署名を分離する。
6. Redis失敗、Worker停止、DB保存失敗にそれぞれ復旧経路を持つ。

## Failure model

- Redis enqueue失敗: Postgresのdelivery行をRecovery Sweeperが再投入する。
- Worker停止: stale `delivering` を `retrying` へ戻す。
- DB保存失敗: 署名検証後のイベントを `/spool/*.json` に原子的保存する。
- VPS/DNS/ネットワーク断: Gateway到達前のため、Provider retry・配信履歴・冗長化で補完する。

## Source of truth

正本はPostgreSQLの `events` と `deliveries` です。Redisは再構築可能な配送キューとして扱います。
