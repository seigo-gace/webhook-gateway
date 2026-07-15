# Implementation Notes

## 技術選定

- Express: raw bodyを扱いやすいWebhook受信API
- PostgreSQL: event ledger / delivery ledger / audit log の正本
- Redis + BullMQ: retry可能な配送キュー
- Standard Webhooks形式: Gatewayから内部アプリへの再署名
- CloudEvents風Envelope: 内部アプリ向けの共通イベント表現

## 直接OSS製品を採用しない理由

Hookdeck Outpost等のOSSは有力ですが、今回の主目的は「外部Providerから入ってくるinbound webhookを各アプリ共通で安全に受ける」ことです。そのため、思想を参考にしつつ、G-ACE向けの独立Gatewayとして実装しています。

## Multi-architecture

Python WheelではなくNode.js公式イメージを使います。multi-arch配布が必要な場合はDocker Buildxで `linux/amd64` と `linux/arm64` を検証してください。

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t gace-webhook-gateway:1.1.1 .
```
