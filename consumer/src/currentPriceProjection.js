const { Long } = require("mongodb");

const FUTURE_TOLERANCE_MS = 30000;
const MAX_OFFSET = 9223372036854775807n;

function normalizeMarketTimestamp(value, now = Date.now()) {
  if (typeof value !== "string" || !Number.isFinite(now)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const digits = fraction.padEnd(9, "0");
  const instantNs = BigInt(milliseconds) * 1000000n + BigInt(digits.slice(3));
  if (instantNs > BigInt(Math.floor(now + FUTURE_TOLERANCE_MS)) * 1000000n) return null;
  const iso = new Date(milliseconds).toISOString();
  if (iso.length !== 24) return null;
  return `${iso.slice(0, 19)}.${digits}Z`;
}

function validateIdentity(topic, partition, offset) {
  if (typeof topic !== "string" || !topic || !Number.isInteger(partition) ||
      partition < 0 || partition > 2147483647 ||
      typeof offset !== "string" || !/^(0|[1-9]\d*)$/.test(offset) ||
      BigInt(offset) > MAX_OFFSET) {
    throw new Error("Invalid Kafka record identity");
  }
}

function parseEvent(record, symbols, now = Date.now()) {
  const { topic, partition, message } = record;
  validateIdentity(topic, partition, message?.offset);
  let event;
  try {
    if (!message.value) return { error: "missing message value" };
    event = JSON.parse(message.value.toString("utf8"));
  } catch {
    return { error: "malformed JSON" };
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return { error: "invalid event" };
  if (typeof event.symbol !== "string" || !symbols.includes(event.symbol)) return { error: "unsupported symbol" };
  if (typeof event.price !== "number" || !Number.isFinite(event.price) || event.price <= 0) {
    return { error: "invalid price" };
  }
  const marketTimeKey = normalizeMarketTimestamp(event.timestamp, now);
  if (!marketTimeKey) return { error: "invalid or future market timestamp" };
  return {
    snapshot: {
      symbol: event.symbol,
      price: event.price,
      marketTimestamp: event.timestamp,
      marketTimeKey,
      receivedAt: new Date(now),
      kafkaTopic: topic,
      kafkaPartition: partition,
      kafkaOffset: Long.fromString(message.offset),
    },
  };
}

function createCurrentPriceProjection(collection) {
  async function save(snapshot) {
    const literal = (value) => ({ $literal: value });
    const wins = {
      $or: [
        { $eq: [{ $type: "$marketTimeKey" }, "missing"] },
        { $gt: [literal(snapshot.marketTimeKey), "$marketTimeKey"] },
        {
          $and: [
            { $eq: [literal(snapshot.marketTimeKey), "$marketTimeKey"] },
            { $or: [
              { $gt: [literal(snapshot.kafkaTopic), "$kafkaTopic"] },
              { $and: [
                { $eq: [literal(snapshot.kafkaTopic), "$kafkaTopic"] },
                { $or: [
                  { $gt: [literal(snapshot.kafkaPartition), "$kafkaPartition"] },
                  { $and: [
                    { $eq: [literal(snapshot.kafkaPartition), "$kafkaPartition"] },
                    { $gt: [literal(snapshot.kafkaOffset), "$kafkaOffset"] },
                  ] },
                ] },
              ] },
            ] },
          ],
        },
      ],
    };
    const fields = Object.fromEntries(Object.entries(snapshot).map(([field, value]) => [
      field, { $cond: [wins, literal(value), `$${field}`] },
    ]));
    try {
      const result = await collection.updateOne(
        { _id: snapshot.symbol }, [{ $set: fields }],
        { upsert: true, collation: { locale: "simple" }, writeConcern: { w: 1 } }
      );
      if (!result.acknowledged) throw new Error("Current-price write was not acknowledged");
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern || error.keyPattern._id !== 1 ||
          Object.keys(error.keyPattern).length !== 1 ||
          !error.keyValue || error.keyValue._id !== snapshot.symbol) throw error;
      const result = await collection.updateOne(
        { _id: snapshot.symbol }, [{ $set: fields }],
        { upsert: false, collation: { locale: "simple" }, writeConcern: { w: 1 } }
      );
      if (!result.acknowledged) throw new Error("Current-price write was not acknowledged");
      if (result.matchedCount !== 1) throw error;
    }
  }
  return { save };
}

module.exports = { FUTURE_TOLERANCE_MS, normalizeMarketTimestamp, parseEvent, createCurrentPriceProjection };
