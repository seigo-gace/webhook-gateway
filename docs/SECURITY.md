# Security Manual

## 必須ルール

1. 署名検証前にpayloadを信用しない。
2. raw bodyを署名対象として保持する。
3. timestamp toleranceでreplay攻撃を落とす。
4. Secret実値は `.env` / Secret Manager に置き、configには環境変数名だけを書く。
5. `/admin/*` は外部公開しない。
6. GatewayからDownstreamへは別Secretで再署名する。
7. 本番入口はHTTPSのみ。

## Runtime hardening

v1.1.1ではAPI/Workerをrootではなく専用非特権ユーザーで動かします。

```text
user: appuser
uid: 10001
gid: 10001
```

Compose側でも以下を適用します。

```yaml
user: "10001:10001"
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

`/spool` はDB保存失敗時の緊急退避に必要なため、`appuser` が書き込める状態にします。

## Admin API

`x-admin-token` 必須です。本番ではNginx、Cloudflare Access、VPN、IP Allowlistなどで二重防御してください。

## Raw body保存

`STORE_RAW_BODY=true` は監査と復旧に強い一方、payload内の機密情報を保存する可能性があります。Providerとデータ種別に応じて保存方針を決めてください。

## Downstream idempotency

Gatewayは at-least-once です。Downstreamは以下で重複排除してください。

- `x-gace-event-id`
- `x-gace-delivery-id`
- CloudEvent `extensions.gatewayEventId`
