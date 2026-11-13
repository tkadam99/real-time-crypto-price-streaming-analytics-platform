# Current-price API

`GET /api/prices/current` reads only the `current_prices` collection and accepts
no query parameters. It returns:

```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "symbol": "BTC-USD",
      "price": 68000,
      "marketTimestamp": "2026-04-04T12:00:00.123456789Z",
      "receivedAt": "2026-04-04T12:00:01.000Z"
    }
  ]
}
```

Only supported symbol IDs are queried. Missing symbols are omitted, and an
empty collection returns `count: 0` and `data: []`. The original market
timestamp string is returned unchanged, including sub-millisecond digits.
`receivedAt` is the projection's processing time, serialized as a UTC ISO
timestamp; it is not market event time or a database commit timestamp.
Kafka identity and internal ordering fields are not exposed.

An invalid supported snapshot or a database failure returns HTTP 500 and logs
the error; no partial response or historical-metrics fallback is used. A
stopped consumer leaves its last snapshots readable, but does not make them
fresh. Clients must assess freshness from `marketTimestamp`, including
future-skewed timestamps. Existing `/api/prices/latest` and `/api/metrics`
continue to return historical-consumer metrics.
