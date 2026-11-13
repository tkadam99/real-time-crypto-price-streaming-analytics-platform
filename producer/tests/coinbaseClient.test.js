const mockHandlers = new Map();
const mockSendMessage = jest.fn();
const mockWebSocket = {
  on: jest.fn((event, handler) => mockHandlers.set(event, handler)),
  send: jest.fn(),
};

jest.mock("ws", () => jest.fn(() => mockWebSocket));
jest.mock("../src/kafkaProducer", () => ({
  sendMessage: mockSendMessage,
}));

const { startCoinbaseStream } = require("../src/coinbaseClient");

describe("Coinbase Kafka publishing", () => {
  let logSpy;
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    mockHandlers.clear();
    mockSendMessage.mockReset();
    mockWebSocket.on.mockClear();
    mockWebSocket.send.mockClear();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    startCoinbaseStream();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  async function emitTicker(overrides = {}) {
    const handler = mockHandlers.get("message");
    await handler(
      Buffer.from(
        JSON.stringify({
          type: "ticker",
          product_id: "BTC-USD",
          price: "68000",
          time: "2026-04-04T12:00:00Z",
          ...overrides,
        })
      )
    );
  }

  it("reports success only after Kafka confirms the publish", async () => {
    mockSendMessage.mockResolvedValue([]);

    for (const product_id of ["BTC-USD", "ETH-USD", "SOL-USD"]) {
      await emitTicker({ product_id });
    }

    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTC-USD", price: 68000 })
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ETH-USD", price: 68000 })
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "SOL-USD", price: 68000 })
    );
    expect(
      logSpy.mock.calls.filter(([message]) => message === "Sent to Kafka:")
    ).toHaveLength(3);
    expect(errorSpy).not.toHaveBeenCalledWith(
      "Failed to publish ticker to Kafka:",
      expect.anything()
    );
  });

  it.each([
    ["missing symbol", { product_id: undefined }],
    ["null symbol", { product_id: null }],
    ["unsupported symbol", { product_id: "DOGE-USD" }],
    ["missing price", { price: undefined }],
    ["null price", { price: null }],
    ["empty price", { price: "" }],
    ["whitespace price", { price: "   " }],
    ["nonnumeric price", { price: "not-a-price" }],
    ["NaN price", { price: "NaN" }],
    ["infinite price", { price: "Infinity" }],
    ["zero price", { price: "0" }],
    ["negative price", { price: "-1" }],
    ["missing timestamp", { time: undefined }],
    ["null timestamp", { time: null }],
    ["invalid timestamp", { time: "not-a-timestamp" }],
    ["empty timestamp", { time: " " }],
  ])("discards ticker with %s before publishing", async (_description, overrides) => {
    await emitTicker(overrides);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Discarding invalid Coinbase ticker:",
      expect.any(String)
    );
    expect(logSpy).not.toHaveBeenCalledWith("Sent to Kafka:", expect.anything());
  });

  it("discards malformed JSON with a diagnostic", async () => {
    await mockHandlers.get("message")(Buffer.from("{invalid json"));

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Discarding malformed Coinbase message:",
      expect.any(String)
    );
  });

  it("handles Kafka rejection without logging a successful publish", async () => {
    mockSendMessage.mockRejectedValue(new Error("Kafka unavailable"));

    await expect(emitTicker()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to publish ticker to Kafka:",
      "Kafka unavailable"
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      "Sent to Kafka:",
      expect.anything()
    );
  });
});
