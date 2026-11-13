const { EventEmitter } = require("node:events");
const { Long } = require("mongodb");
const { normalizeMarketTimestamp, parseEvent, createCurrentPriceProjection } = require("../src/currentPriceProjection");
const { CURRENT_PRICE_GROUP, createCurrentPriceService } = require("../src/currentPriceConsumer");

const now = Date.parse("2026-01-01T00:01:00Z");
const symbols = ["BTC-USD", "ETH-USD", "SOL-USD"];
const valid = { symbol: "BTC-USD", price: 100, timestamp: "2026-01-01T00:00:00.123456789Z" };
function record(event = valid, offset = "9007199254740993") {
  return { topic: "topic", partition: 1, message: { offset, value: Buffer.from(JSON.stringify(event)) } };
}

describe("current price validation", () => {
  test("normalizes offsets and retains nanosecond precision across time zones", () => {
    expect(normalizeMarketTimestamp("2026-01-01T01:00:00.123456789+01:00", now))
      .toBe("2026-01-01T00:00:00.123456789Z");
    expect(normalizeMarketTimestamp("2026-01-01T00:00:00.1Z", now))
      .toBe("2026-01-01T00:00:00.100000000Z");
    const snapshot = parseEvent(record(), symbols, now).snapshot;
    expect(snapshot).toMatchObject({ symbol: "BTC-USD", price: 100, marketTimestamp: valid.timestamp, kafkaTopic: "topic", kafkaPartition: 1, receivedAt: new Date(now) });
    expect(snapshot.kafkaOffset.equals(Long.fromString("9007199254740993"))).toBe(true);
  });

  test.each([
    [{ ...valid, symbol: "DOGE-USD" }, "unsupported symbol"],
    [{ ...valid, price: "1" }, "invalid price"],
    [{ ...valid, price: 0 }, "invalid price"],
    [{ ...valid, price: -1 }, "invalid price"],
    [{ ...valid, timestamp: null }, "invalid or future market timestamp"],
    [{ ...valid, timestamp: "2026-02-29T00:00:00Z" }, "invalid or future market timestamp"],
    [{ ...valid, timestamp: "2026-01-01T00:00:00.1234567891Z" }, "invalid or future market timestamp"],
    [{ ...valid, timestamp: "2026-01-01T00:01:30.000000001Z" }, "invalid or future market timestamp"],
  ])("rejects permanent invalid input", (event, error) => {
    expect(parseEvent(record(event), symbols, now)).toEqual({ error });
  });

  test("accepts the exact future tolerance boundary but no later", () => {
    expect(normalizeMarketTimestamp("2026-01-01T00:01:30Z", now)).not.toBeNull();
    expect(normalizeMarketTimestamp("2026-01-01T00:01:30.000000001Z", now)).toBeNull();
  });

  test("handles malformed JSON and rejects invalid identities without skipping them", () => {
    const malformed = record();
    malformed.message.value = Buffer.from("{");
    expect(parseEvent(malformed, symbols, now)).toEqual({ error: "malformed JSON" });
    for (const bad of ["-1", "1.5", "9223372036854775808", null]) {
      expect(() => parseEvent(record(valid, bad), symbols, now)).toThrow("Invalid Kafka record identity");
    }
    expect(() => parseEvent({ ...record(), partition: -1 }, symbols, now)).toThrow("Invalid Kafka record identity");
  });
});

describe("current price projection writes", () => {
  const snapshot = parseEvent(record(), symbols, now).snapshot;
  test("uses one atomic upsert keyed by symbol and a conditional update pipeline", async () => {
    const collection = { updateOne: jest.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }) };
    await createCurrentPriceProjection(collection).save(snapshot);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "BTC-USD" },
      [expect.objectContaining({ $set: expect.objectContaining({ marketTimeKey: expect.objectContaining({ $cond: expect.any(Array) }) }) })],
      { upsert: true, collation: { locale: "simple" }, writeConcern: { w: 1 } }
    );
  });

  test("retries only an _id upsert race and propagates other failures", async () => {
    const duplicate = Object.assign(new Error("race"), { code: 11000, keyPattern: { _id: 1 }, keyValue: { _id: "BTC-USD" } });
    const collection = { updateOne: jest.fn().mockRejectedValueOnce(duplicate).mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 }) };
    await createCurrentPriceProjection(collection).save(snapshot);
    expect(collection.updateOne.mock.calls[1][2].upsert).toBe(false);
    collection.updateOne.mockReset().mockRejectedValueOnce(duplicate).mockResolvedValueOnce({ acknowledged: true, matchedCount: 0 });
    await expect(createCurrentPriceProjection(collection).save(snapshot)).rejects.toBe(duplicate);
    const failure = new Error("database down");
    collection.updateOne.mockReset().mockRejectedValue(failure);
    await expect(createCurrentPriceProjection(collection).save(snapshot)).rejects.toBe(failure);
    const otherDuplicate = Object.assign(new Error("other unique index"), { code: 11000, keyPattern: { price: 1 }, keyValue: { price: 100 } });
    collection.updateOne.mockReset().mockRejectedValue(otherDuplicate);
    await expect(createCurrentPriceProjection(collection).save(snapshot)).rejects.toBe(otherDuplicate);
    collection.updateOne.mockReset().mockResolvedValue({ acknowledged: false });
    await expect(createCurrentPriceProjection(collection).save(snapshot)).rejects.toThrow("not acknowledged");
  });
});

describe("current price consumer lifecycle", () => {
  let consumer, mongoClient, processObject, logger, collection, service;
  beforeEach(() => {
    collection = { updateOne: jest.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }) };
    mongoClient = { connect: jest.fn().mockResolvedValue(), close: jest.fn().mockResolvedValue(), db: jest.fn(() => ({ collection: jest.fn(() => collection) })) };
    consumer = {
      events: { CRASH: "crash" }, on: jest.fn(() => jest.fn()),
      connect: jest.fn().mockResolvedValue(), subscribe: jest.fn().mockResolvedValue(),
      run: jest.fn().mockResolvedValue(), stop: jest.fn().mockResolvedValue(), disconnect: jest.fn().mockResolvedValue(),
    };
    processObject = new EventEmitter();
    processObject.exit = jest.fn();
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service = createCurrentPriceService({ consumer, mongoClient, dbName: "test", topic: "topic", symbols, processObject, logger, now: () => now });
  });
  test("uses an independent stable group and subscribes at latest on missing offsets", async () => {
    expect(CURRENT_PRICE_GROUP).toBe("crypto-current-price-group");
    expect(CURRENT_PRICE_GROUP).not.toBe("crypto-analytics-group");
    await service.start();
    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: "topic", fromBeginning: false });
    expect(consumer.run).toHaveBeenCalledWith({ eachMessage: expect.any(Function) });
    await service.shutdown("test");
  });
  test("waits for persistence, skips invalid input, and propagates write failures", async () => {
    await service.start();
    const callback = consumer.run.mock.calls[0][0].eachMessage;
    await callback(record({ ...valid, symbol: "UNKNOWN" }));
    expect(logger.warn).toHaveBeenCalled();
    expect(collection.updateOne).not.toHaveBeenCalled();
    let finishWrite;
    collection.updateOne.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    let finished = false;
    const pending = callback(record()).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    finishWrite({ acknowledged: true, matchedCount: 1 });
    await pending;
    expect(finished).toBe(true);
    const failure = new Error("write failed");
    collection.updateOne.mockRejectedValueOnce(failure);
    await expect(callback(record())).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith("Current-price processing failed:", "write failed");
    await service.shutdown("test");
  });
  test.each(["SIGINT", "SIGTERM"])("shuts down cleanly on %s", async (signal) => {
    await service.start();
    processObject.emit(signal);
    await service.shutdown("duplicate");
    expect(consumer.stop).toHaveBeenCalledTimes(1);
    expect(consumer.disconnect.mock.invocationCallOrder[0]).toBeLessThan(mongoClient.close.mock.invocationCallOrder[0]);
    expect(processObject.exit).toHaveBeenCalledWith(0);
  });
  test("cleans up after a database startup error", async () => {
    mongoClient.connect.mockRejectedValue(new Error("unavailable"));
    await service.start();
    expect(mongoClient.close).toHaveBeenCalled();
    expect(processObject.exit).toHaveBeenCalledWith(1);
  });
  test("cleans up on an unrecoverable Kafka crash", async () => {
    await service.start();
    const listener = consumer.on.mock.calls[0][1];
    listener({ payload: { error: new Error("broker failure"), restart: false } });
    await service.shutdown("duplicate");
    expect(processObject.exit).toHaveBeenCalledWith(1);
    expect(consumer.disconnect).toHaveBeenCalled();
    expect(mongoClient.close).toHaveBeenCalled();
  });
});
