const mockSendMessage = jest.fn();
const mockSockets = [];

jest.mock("../src/kafkaProducer", () => ({ sendMessage: mockSendMessage }));
jest.mock("ws", () => {
  const { EventEmitter } = require("events");
  return class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() {
      super();
      this.readyState = 1;
      this.send = jest.fn();
      this.close = jest.fn();
      this.terminate = jest.fn();
      mockSockets.push(this);
    }
  };
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Coinbase shutdown", () => {
  let coinbase;
  let ws;
  let logSpy;
  let errorSpy;
  let warnSpy;
  const ticker = Buffer.from(JSON.stringify({
    type: "ticker", product_id: "BTC-USD", price: "100", time: "2040-01-01T12:00:00Z",
  }));

  beforeEach(() => {
    jest.resetModules();
    mockSockets.length = 0;
    mockSendMessage.mockReset().mockResolvedValue([]);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    coinbase = require("../src/coinbaseClient");
    coinbase.startCoinbaseStream();
    [ws] = mockSockets;
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("drains confirmed sends, ignores new events, and closes the socket", async () => {
    const pending = deferred();
    mockSendMessage.mockReturnValue(pending.promise);
    ws.emit("message", ticker);
    coinbase.beginCoinbaseShutdown();
    const closing = coinbase.stopCoinbaseStream();
    const drained = jest.fn();
    const drain = coinbase.drainPublishes().then(drained);
    ws.emit("message", ticker);
    ws.emit("open");
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    ws.readyState = 3;
    ws.emit("close");
    await closing;
    pending.resolve([]);
    await drain;
    expect(drained).toHaveBeenCalledTimes(1);
    expect(coinbase.hasShutdownPublishFailure()).toBe(false);
    expect(logSpy).not.toHaveBeenCalledWith("Sent to Kafka:", expect.anything());
  });

  it("reports failed outstanding publishes without an unhandled rejection", async () => {
    const pending = deferred();
    mockSendMessage.mockReturnValue(pending.promise);
    ws.emit("message", ticker);
    coinbase.beginCoinbaseShutdown();
    const drain = coinbase.drainPublishes();
    pending.reject(new Error("Kafka down"));
    await drain;
    expect(coinbase.hasShutdownPublishFailure()).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith("Failed to publish ticker to Kafka:", "Kafka down");
    expect(logSpy).not.toHaveBeenCalledWith("Sent to Kafka:", expect.anything());
  });

  it("disconnects only after the actual WebSocket handler's outstanding publish settles", async () => {
    const pending = deferred();
    mockSendMessage.mockReturnValue(pending.promise);
    ws.emit("message", ticker);
    const processObject = new (require("events").EventEmitter)();
    const exited = deferred();
    processObject.exit = jest.fn(exited.resolve);
    const disconnect = jest.fn().mockResolvedValue();
    const lifecycle = require("../src/index").createLifecycle({
      processObject,
      connect: jest.fn().mockResolvedValue(),
      startStream: jest.fn(),
      disconnect,
    });
    await lifecycle.start();
    processObject.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    ws.readyState = 3;
    ws.emit("close");
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnect).not.toHaveBeenCalled();
    pending.resolve([]);
    expect(await exited.promise).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled reconnect and ignores later close callbacks", () => {
    jest.useFakeTimers();
    ws.emit("close");
    coinbase.beginCoinbaseShutdown();
    jest.advanceTimersByTime(6000);
    coinbase.startCoinbaseStream();
    ws.emit("close");
    jest.advanceTimersByTime(6000);
    expect(mockSockets).toHaveLength(1);
  });

  it("propagates close errors and allows forced termination", async () => {
    ws.close.mockImplementation(() => { throw new Error("close failed"); });
    coinbase.beginCoinbaseShutdown();
    await expect(coinbase.stopCoinbaseStream()).rejects.toThrow("close failed");
    coinbase.terminateCoinbaseStream();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it("treats the expected connecting-handshake abort as a clean close", async () => {
    ws.readyState = 0;
    ws.close.mockImplementation(() => {
      ws.readyState = 2;
      ws.emit("error", new Error("WebSocket was closed before the connection was established"));
      ws.readyState = 3;
      ws.emit("close");
    });
    coinbase.beginCoinbaseShutdown();
    await expect(coinbase.stopCoinbaseStream()).resolves.toBeUndefined();
  });

  it("reports unexpected connecting-handshake errors", async () => {
    ws.readyState = 0;
    ws.close.mockImplementation(() => {
      ws.emit("error", new Error("unexpected handshake failure"));
      ws.readyState = 3;
      ws.emit("close");
    });
    coinbase.beginCoinbaseShutdown();
    await expect(coinbase.stopCoinbaseStream()).rejects.toThrow("unexpected handshake failure");
  });
});
