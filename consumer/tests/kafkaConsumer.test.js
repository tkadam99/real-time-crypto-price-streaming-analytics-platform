const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({
    consumer: jest.fn(() => mockConsumer),
  })),
}));

jest.mock("../src/mongoClient", () => ({
  getDB: jest.fn(),
}));

const { getDB } = require("../src/mongoClient");
const { startConsumer } = require("../src/kafkaConsumer");

describe("Kafka consumer message handling", () => {
  let errorSpy;
  let warnSpy;
  let eachMessage;
  let indexCollections;
  let nextOffset;
  let testTopic;
  let testSequence = 0;

  beforeEach(async () => {
    jest.clearAllMocks();
    nextOffset = 0;
    testTopic = `crypto-prices-test-${++testSequence}`;
    mockConsumer.connect.mockResolvedValue();
    mockConsumer.subscribe.mockResolvedValue();
    mockConsumer.run.mockResolvedValue();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    indexCollections = new Map();
    getDB.mockReturnValue({
      collection: jest.fn((name) => {
        if (!indexCollections.has(name)) {
          indexCollections.set(name, {
            aggregate: jest.fn(() => ({
              toArray: jest.fn().mockResolvedValue([]),
            })),
            createIndex: jest.fn().mockResolvedValue("index"),
          });
        }
        return indexCollections.get(name);
      }),
    });

    await startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function evaluateExpression(expression, document) {
    if (typeof expression === "string" && expression.startsWith("$")) {
      return document[expression.slice(1)];
    }

    if (!expression || typeof expression !== "object" || expression instanceof Date) {
      return expression;
    }

    if (Array.isArray(expression)) {
      return expression.map((item) => evaluateExpression(item, document));
    }

    if ("$literal" in expression) return expression.$literal;
    if ("$convert" in expression) {
      const { input, onError, onNull } = expression.$convert;
      const value = evaluateExpression(input, document);
      if (value == null) return onNull;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? onError : date;
    }
    if ("$eq" in expression) {
      const [left, right] = expression.$eq.map((item) =>
        evaluateExpression(item, document)
      );
      return left instanceof Date && right instanceof Date
        ? left.getTime() === right.getTime()
        : left === right;
    }
    if ("$gt" in expression || "$gte" in expression) {
      const operator = "$gt" in expression ? "$gt" : "$gte";
      const [left, right] = expression[operator].map((item) =>
        evaluateExpression(item, document)
      );
      const leftValue = left instanceof Date ? left.getTime() : left;
      const rightValue = right instanceof Date ? right.getTime() : right;
      return operator === "$gt" ? leftValue > rightValue : leftValue >= rightValue;
    }
    if ("$or" in expression) {
      return expression.$or.some((item) => evaluateExpression(item, document));
    }
    if ("$cond" in expression) {
      const [condition, whenTrue, whenFalse] = expression.$cond;
      return evaluateExpression(condition, document)
        ? evaluateExpression(whenTrue, document)
        : evaluateExpression(whenFalse, document);
    }

    return Object.fromEntries(
      Object.entries(expression).map(([key, value]) => [
        key,
        evaluateExpression(value, document),
      ])
    );
  }

  function configureDatabase(options = {}) {
    const rawUpdateOne = options.rawUpdateOne || jest.fn();
    const updateOne = options.updateOne || jest.fn();
    const storedPriceEvents = [];
    const metricsDocuments = new Map();
    const alerts = new Map();
    if (!options.rawUpdateOne) {
      rawUpdateOne.mockImplementation(async (filter, update) => {
        if (storedPriceEvents.some((event) => event._id === filter._id)) {
          return { matchedCount: 1, upsertedCount: 0 };
        }
        storedPriceEvents.push({ _id: filter._id, ...update.$setOnInsert });
        return { matchedCount: 0, upsertedCount: 1 };
      });
    }

    const recentEventsCursor = {
      sort: jest.fn((sortSpec) => {
        recentEventsCursor.sortSpec = sortSpec;
        return recentEventsCursor;
      }),
      limit: jest.fn((limit) => {
        recentEventsCursor.limitValue = limit;
        return recentEventsCursor;
      }),
      toArray: jest.fn(async () => {
        const direction = Object.values(recentEventsCursor.sortSpec)[0];
        return [...storedPriceEvents]
          .sort(
            (left, right) =>
              direction *
              (Date.parse(left.timestamp) - Date.parse(right.timestamp))
          )
          .slice(0, recentEventsCursor.limitValue);
      }),
      project: jest.fn(() => recentEventsCursor),
    };
    const priceEventsCollection = {
      updateOne: rawUpdateOne,
      findOne: jest.fn(async (filter) =>
        storedPriceEvents.find((event) => event._id === filter._id) || null
      ),
      countDocuments: jest.fn(async ({ symbol }) =>
        storedPriceEvents.filter((event) => event.symbol === symbol).length
      ),
      find: jest.fn(() => recentEventsCursor),
    };
    if (!options.updateOne || options.failMetricsOnce) {
      let failedMetricsWrite = false;
      let racedMetricsUpsert = false;
      updateOne.mockImplementation(async (filter, pipeline, updateOptions) => {
        if (options.failMetricsOnce && !failedMetricsWrite) {
          failedMetricsWrite = true;
          throw options.failMetricsOnce;
        }

        if (options.metricsDuplicateRace && !racedMetricsUpsert) {
          racedMetricsUpsert = true;
          metricsDocuments.set(filter.symbol, {
            symbol: filter.symbol,
            ...options.metricsDuplicateRace.document,
          });
          throw options.metricsDuplicateRace.error;
        }

        let document = metricsDocuments.get(filter.symbol);
        if (!document && updateOptions.upsert) {
          document = { symbol: filter.symbol };
        }

        for (const stage of pipeline) {
          const assignments = Object.fromEntries(
            Object.entries(stage.$set).map(([key, expression]) => [
              key,
              evaluateExpression(expression, document),
            ])
          );
          document = { ...document, ...assignments };
        }

        metricsDocuments.set(filter.symbol, document);
        return {};
      });
    }
    const metricsCollection = {
      updateOne,
      findOne: jest.fn(async ({ symbol }) => metricsDocuments.get(symbol) || null),
      createIndex: jest.fn().mockResolvedValue("unique_metrics_symbol"),
      aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
    };
    const alertUpdateOne = options.alertUpdateOne || jest.fn();
    if (!options.alertUpdateOne) {
      alertUpdateOne.mockImplementation(async (filter, update) => {
        if (alerts.has(filter._id)) {
          return { matchedCount: 1, upsertedCount: 0 };
        }
        alerts.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
        return { matchedCount: 0, upsertedCount: 1 };
      });
    }
    const alertsCollection = {
      updateOne: alertUpdateOne,
      findOne: jest.fn(async (filter) => alerts.get(filter._id) || null),
    };

    getDB.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === "price_events") return priceEventsCollection;
        if (name === "metrics") return metricsCollection;
        return alertsCollection;
      }),
    });

    return {
      priceEventsCollection,
      metricsCollection,
      metricsDocuments,
      storedPriceEvents,
      alerts,
      alertsCollection,
      alertUpdateOne,
    };
  }

  function kafkaMessage(value, identity = {}) {
    const { topic = testTopic, partition = 0, offset } = identity;
    return {
      topic,
      partition,
      message: {
        value: Buffer.from(value),
        offset: offset === undefined ? String(nextOffset++) : String(offset),
      },
    };
  }

  it.each(["BTC-USD", "ETH-USD", "SOL-USD"])(
    "processes a valid %s event after persistence and metric update",
    async (symbol) => {
      const { priceEventsCollection, metricsDocuments } = configureDatabase();
      const event = {
        symbol,
        price: 100,
        timestamp: "2026-04-04T12:00:00.000Z",
      };

      await expect(
        eachMessage(kafkaMessage(JSON.stringify(event)))
      ).resolves.toBeUndefined();

      expect(priceEventsCollection.updateOne).toHaveBeenCalledWith(
        { _id: expect.any(String) },
        {
          $setOnInsert: expect.objectContaining(event),
        },
        { upsert: true }
      );
      expect(metricsDocuments.get(symbol)).toMatchObject({
        symbol,
        latestPrice: 100,
        movingAverage: 100,
        percentChange: 0,
        updatedAt: event.timestamp,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    }
  );

  it("creates a unique index on metrics.symbol before consuming", () => {
    const metricsCollection = indexCollections.get("metrics");

    expect(metricsCollection.createIndex).toHaveBeenCalledWith(
      { symbol: 1 },
      { unique: true, name: "unique_metrics_symbol" }
    );
    expect(metricsCollection.aggregate).toHaveBeenCalled();
  });

  it("refuses startup when duplicate metric symbols already exist", async () => {
    const connectCallCount = mockConsumer.connect.mock.calls.length;
    getDB.mockReturnValue({
      collection: jest.fn(() => ({
        aggregate: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([{ _id: "BTC-USD", count: 2 }]),
        })),
        createIndex: jest.fn(),
      })),
    });

    await expect(startConsumer()).rejects.toThrow(
      "duplicate symbols already exist: BTC-USD"
    );
    expect(mockConsumer.connect).toHaveBeenCalledTimes(connectCallCount);
  });

  it("persists one raw event and snapshot for the first Kafka record delivery", async () => {
    const { storedPriceEvents, metricsDocuments } = configureDatabase();
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2030-01-01T12:00:00.000Z",
    };
    const record = kafkaMessage(JSON.stringify(event), { offset: "42" });

    await eachMessage(record);

    expect(storedPriceEvents).toHaveLength(1);
    expect(storedPriceEvents[0]._id).toBe(
      JSON.stringify([testTopic, 0, "42"])
    );
    expect(metricsDocuments.get("BTC-USD").latestPrice).toBe(100);
  });

  it("replays the same Kafka record without duplicating raw history or the moving average", async () => {
    const { storedPriceEvents, metricsDocuments } = configureDatabase();
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2030-01-01T12:00:00.000Z",
    };
    const record = kafkaMessage(JSON.stringify(event), { offset: "42" });

    await eachMessage(record);
    await eachMessage(record);

    expect(storedPriceEvents).toHaveLength(1);
    expect(metricsDocuments.get("BTC-USD")).toMatchObject({
      latestPrice: 100,
      movingAverage: 100,
      updatedAt: event.timestamp,
    });
  });

  it("persists distinct Kafka records with identical market data", async () => {
    const { storedPriceEvents, metricsDocuments } = configureDatabase();
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2030-01-01T12:00:00.000Z",
    };

    await eachMessage(kafkaMessage(JSON.stringify(event), { offset: "42" }));
    await eachMessage(kafkaMessage(JSON.stringify(event), { offset: "43" }));

    expect(storedPriceEvents).toHaveLength(2);
    expect(metricsDocuments.get("BTC-USD").movingAverage).toBe(100);
  });

  it("does not create duplicate spike alerts when the same Kafka record is replayed", async () => {
    const { alerts, alertUpdateOne } = configureDatabase();
    const records = [
      {
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2040-01-01T12:00:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2040-01-01T12:01:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 102,
        timestamp: "2040-01-01T12:02:00.000Z",
      },
    ];

    await eachMessage(kafkaMessage(JSON.stringify(records[0]), { offset: "1" }));
    await eachMessage(kafkaMessage(JSON.stringify(records[1]), { offset: "2" }));
    const spikeRecord = kafkaMessage(JSON.stringify(records[2]), { offset: "3" });
    await eachMessage(spikeRecord);
    await eachMessage(spikeRecord);

    expect(alerts.size).toBe(1);
    expect(alertUpdateOne).toHaveBeenCalledTimes(2);
    expect([...alerts.values()][0]).toMatchObject({
      symbol: "BTC-USD",
      percentChange: 2,
      timestamp: records[2].timestamp,
    });
  });

  it("recovers an alert write that failed after raw and metrics persistence", async () => {
    const alertError = new Error("temporary alert persistence failure");
    const alerts = new Map();
    let failedFirstWrite = false;
    const alertUpdateOne = jest.fn(async (filter, update) => {
      if (!failedFirstWrite) {
        failedFirstWrite = true;
        throw alertError;
      }
      if (alerts.has(filter._id)) {
        return { matchedCount: 1, upsertedCount: 0 };
      }
      alerts.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
      return { matchedCount: 0, upsertedCount: 1 };
    });
    const database = configureDatabase({ alertUpdateOne });
    const records = [
      {
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2045-01-01T12:00:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2045-01-01T12:01:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 102,
        timestamp: "2045-01-01T12:02:00.000Z",
      },
    ];

    await eachMessage(kafkaMessage(JSON.stringify(records[0]), { offset: "1" }));
    await eachMessage(kafkaMessage(JSON.stringify(records[1]), { offset: "2" }));
    const spikeRecord = kafkaMessage(JSON.stringify(records[2]), { offset: "3" });

    await expect(eachMessage(spikeRecord)).rejects.toBe(alertError);
    expect(database.storedPriceEvents[2].alertCandidate).toMatchObject({
      percentChange: 2,
      timestamp: records[2].timestamp,
    });

    await eachMessage(spikeRecord);

    expect(database.storedPriceEvents).toHaveLength(3);
    expect(database.metricsDocuments.get("BTC-USD").latestPrice).toBe(102);
    expect(alerts.size).toBe(1);
    expect(alertUpdateOne).toHaveBeenCalledTimes(2);
  });

  it("reprocesses downstream writes after raw persistence succeeded but metrics failed", async () => {
    const failure = new Error("temporary metrics failure");
    const database = configureDatabase({ failMetricsOnce: failure });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2042-01-01T12:00:00.000Z",
    };
    const record = kafkaMessage(JSON.stringify(event), { offset: "42" });

    await expect(eachMessage(record)).rejects.toBe(failure);
    await eachMessage(record);

    expect(database.storedPriceEvents).toHaveLength(1);
    expect(database.metricsDocuments.get("BTC-USD")).toMatchObject({
      latestPrice: 100,
      movingAverage: 100,
    });
    expect(database.metricsCollection.updateOne).toHaveBeenCalledTimes(2);
  });

  it("continues after an expected duplicate-key race when the Kafka record exists", async () => {
    const duplicateError = Object.assign(new Error("duplicate key"), {
      code: 11000,
    });
    let injectedDuplicate = false;
    const database = configureDatabase({
      rawUpdateOne: jest.fn(async (filter, update) => {
        if (!injectedDuplicate) {
          injectedDuplicate = true;
          database.storedPriceEvents.push({
            _id: filter._id,
            ...update.$setOnInsert,
          });
          throw duplicateError;
        }
        return { matchedCount: 1, upsertedCount: 0 };
      }),
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2041-01-01T12:00:00.000Z",
    };

    await expect(
      eachMessage(kafkaMessage(JSON.stringify(event), { offset: "42" }))
    ).resolves.toBeUndefined();
    expect(database.storedPriceEvents).toHaveLength(1);
    expect(database.metricsDocuments.get("BTC-USD").latestPrice).toBe(100);
  });

  it("keeps the normal chronological snapshot and analytics values", async () => {
    const { metricsDocuments } = configureDatabase();
    const firstEvent = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2050-01-01T12:00:00.000Z",
    };
    const secondEvent = {
      symbol: "BTC-USD",
      price: 110,
      timestamp: "2050-01-01T12:01:00.000Z",
    };

    await eachMessage(kafkaMessage(JSON.stringify(firstEvent)));
    await eachMessage(kafkaMessage(JSON.stringify(secondEvent)));

    expect(metricsDocuments.get("BTC-USD")).toMatchObject({
      latestPrice: 110,
      previousPrice: 100,
      movingAverage: 105,
      percentChange: 10,
      updatedAt: secondEvent.timestamp,
    });
  });

  it("does not let a late older event regress snapshot fields and refreshes the affected moving average", async () => {
    const { metricsDocuments } = configureDatabase();
    const events = [
      {
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2060-01-01T12:00:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 110,
        timestamp: "2060-01-01T12:01:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 105,
        timestamp: "2060-01-01T12:00:30.000Z",
      },
    ];

    for (const event of events) {
      await eachMessage(kafkaMessage(JSON.stringify(event)));
    }

    expect(metricsDocuments.get("BTC-USD")).toMatchObject({
      latestPrice: 110,
      previousPrice: 100,
      movingAverage: 105,
      percentChange: 10,
      updatedAt: events[1].timestamp,
    });
  });

  it("keeps the first snapshot values for equal timestamps while recalculating the moving average", async () => {
    const { metricsDocuments } = configureDatabase();
    const events = [
      {
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2070-01-01T12:00:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 110,
        timestamp: "2070-01-01T12:01:00.000Z",
      },
      {
        symbol: "BTC-USD",
        price: 120,
        timestamp: "2070-01-01T12:01:00.000Z",
      },
    ];

    for (const event of events) {
      await eachMessage(kafkaMessage(JSON.stringify(event)));
    }

    expect(metricsDocuments.get("BTC-USD")).toMatchObject({
      latestPrice: 110,
      previousPrice: 100,
      movingAverage: 110,
      percentChange: 10,
      updatedAt: events[1].timestamp,
    });
  });

  it("creates a metrics snapshot for a newly initialized symbol", async () => {
    const { metricsDocuments } = configureDatabase();
    const event = {
      symbol: "ETH-USD",
      price: 2500,
      timestamp: "2080-01-01T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).resolves.toBeUndefined();

    expect(metricsDocuments.get("ETH-USD")).toMatchObject({
      symbol: "ETH-USD",
      latestPrice: 2500,
      previousPrice: null,
      movingAverage: 2500,
      percentChange: 0,
      updatedAt: event.timestamp,
    });
  });

  it("recovers a concurrent first metrics upsert through the unique symbol index", async () => {
    const duplicateError = Object.assign(new Error("duplicate key"), {
      code: 11000,
    });
    const database = configureDatabase({
      metricsDuplicateRace: {
        error: duplicateError,
        document: {
          latestPrice: 90,
          previousPrice: 80,
          movingAverage: 85,
          percentChange: 12.5,
          updatedAt: "2091-01-01T11:59:00.000Z",
        },
      },
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2091-01-01T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).resolves.toBeUndefined();

    expect(database.metricsCollection.updateOne).toHaveBeenCalledTimes(2);
    expect(database.metricsCollection.updateOne.mock.calls[1][2]).toEqual({
      upsert: false,
    });
    expect(database.metricsDocuments.size).toBe(1);
    expect(database.metricsDocuments.get("BTC-USD")).toMatchObject({
      latestPrice: 100,
      updatedAt: event.timestamp,
    });
  });

  it("logs and discards malformed JSON without processing it", async () => {
    getDB.mockClear();

    await expect(eachMessage(kafkaMessage("{invalid json"))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Discarding malformed Kafka event JSON:",
      expect.any(String)
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it.each([
    ["null event", "null"],
    [
      "missing symbol",
      JSON.stringify({ price: 1, timestamp: "2026-04-04T12:00:00Z" }),
    ],
    [
      "unsupported symbol",
      JSON.stringify({
        symbol: "DOGE-USD",
        price: 1,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "missing price",
      JSON.stringify({ symbol: "BTC-USD", timestamp: "2026-04-04T12:00:00Z" }),
    ],
    [
      "null price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: null,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "empty price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "whitespace price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "   ",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "nonnumeric price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "nope",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "NaN price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "NaN",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "non-finite price",
      '{"symbol":"BTC-USD","price":1e1000,"timestamp":"2026-04-04T12:00:00Z"}',
    ],
    [
      "zero price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: 0,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "negative price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: -1,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "missing timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1 }),
    ],
    [
      "null timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1, timestamp: null }),
    ],
    [
      "empty timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1, timestamp: "" }),
    ],
    [
      "invalid timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1, timestamp: "invalid" }),
    ],
  ])("discards %s before database access", async (_description, value) => {
    getDB.mockClear();

    await expect(eachMessage(kafkaMessage(value))).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      "Discarding invalid Kafka event:",
      expect.any(String)
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("discards an event without a Kafka value", async () => {
    getDB.mockClear();

    await expect(eachMessage({ message: { value: null } })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "Discarding invalid Kafka event: message value is missing"
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("rejects the callback when MongoDB persistence fails", async () => {
    const persistenceError = new Error("MongoDB write failed");
    configureDatabase({
      rawUpdateOne: jest.fn().mockRejectedValue(persistenceError),
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2026-04-04T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).rejects.toBe(
      persistenceError
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("rejects the callback when the atomic metrics update fails", async () => {
    const updateError = new Error("Metrics update failed");
    configureDatabase({
      updateOne: jest.fn().mockRejectedValue(updateError),
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2090-01-01T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).rejects.toBe(
      updateError
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("propagates unexpected processing errors instead of treating them as success", async () => {
    const processingError = new Error("Unexpected database access error");
    getDB.mockImplementation(() => {
      throw processingError;
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2026-04-04T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).rejects.toBe(
      processingError
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
