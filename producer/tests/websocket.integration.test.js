const WebSocket = require("ws");
const { once } = require("events");

jest.mock("../src/kafkaProducer", () => ({ sendMessage: jest.fn().mockResolvedValue([]) }));
jest.mock("../src/config", () => ({
  get coinbaseWsUrl() { return global.__producerTestWsUrl; },
  symbols: ["BTC-USD"],
}));

describe("local WebSocket shutdown", () => {
  let server;
  let coinbase;
  let logSpy;
  let errorSpy;
  let warnSpy;

  beforeEach(async () => {
    jest.resetModules();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    server = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    global.__producerTestWsUrl = `ws://127.0.0.1:${server.address().port}`;
    coinbase = require("../src/coinbaseClient");
  });

  afterEach(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    delete global.__producerTestWsUrl;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("completes the actual WebSocket close handshake", async () => {
    const connected = once(server, "connection");
    coinbase.startCoinbaseStream();
    await connected;
    coinbase.beginCoinbaseShutdown();
    await expect(coinbase.stopCoinbaseStream()).resolves.toBeUndefined();
    await expect(coinbase.drainPublishes()).resolves.toBeUndefined();
  });

  it("closes cleanly while the WebSocket handshake is connecting", async () => {
    coinbase.startCoinbaseStream();
    coinbase.beginCoinbaseShutdown();
    await expect(coinbase.stopCoinbaseStream()).resolves.toBeUndefined();
  });
});
