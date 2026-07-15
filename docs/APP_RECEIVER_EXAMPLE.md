# Downstream Receiver Example

内部アプリはGatewayから届くWebhookを再検証し、重複処理を防ぎます。

```ts
import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.post('/internal/webhooks', express.raw({ type: '*/*' }), (req, res) => {
  const id = req.header('webhook-id');
  const ts = req.header('webhook-timestamp');
  const sig = req.header('webhook-signature');
  const secret = Buffer.from(process.env.OUTBOUND_APP_SECRET!.replace(/^base64:/, ''), 'base64');

  if (!id || !ts || !sig) return res.status(401).send('missing signature');

  const expected = crypto.createHmac('sha256', secret)
    .update(`${id}.${ts}.${req.body.toString('utf8')}`)
    .digest('base64');

  if (!sig.split(' ').some((part) => part === `v1,${expected}`)) {
    return res.status(401).send('bad signature');
  }

  const event = JSON.parse(req.body.toString('utf8'));
  const gatewayEventId = event.extensions?.gatewayEventId;

  // 本番では gatewayEventId をDBに保存し、既存なら即2xxを返す。
  console.log(gatewayEventId, event.type);
  return res.status(204).send();
});
```
