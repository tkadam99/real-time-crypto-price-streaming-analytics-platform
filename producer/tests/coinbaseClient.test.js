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

  beforeEach(() => {
    mockHandlers.clear();
    mockSendMessage.mockReset();
    mockWebSocket.on.mockClear();
    mockWebSocket.send.mockClear();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    startCoinbaseStream();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function emitTicker() {
    const handler = mockHandlers.get("message");
    await handler(
      Buffer.from(
        JSON.stringify({
          type: "ticker",
          product_id: "BTC-USD",
          price: "68000",
          time: "2026-04-04T12:00:00Z",
        })
      )
    );
  }

  it("reports success only after Kafka confirms the publish", async () => {
    mockSendMessage.mockResolvedValue([]);

    await emitTicker();

    expect(logSpy).toHaveBeenCalledWith(
      "Sent to Kafka:",
      expect.objectContaining({ symbol: "BTC-USD", price: 68000 })
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      "Failed to publish ticker to Kafka:",
      expect.anything()
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
