# Downstream Receiver Contract

Downstream apps must verify Gateway signatures and dedupe by `x-gace-event-id` or CloudEvent `extensions.gatewayEventId`.

If using `successMode=status_and_header`, return:

```text
HTTP 2xx
x-gace-accepted: true
```

Do not return the accepted header before the downstream app has durably recorded the event id for idempotency.
