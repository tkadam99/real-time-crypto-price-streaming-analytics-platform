const { EventEmitter } = require("events");
const { createLifecycle } = require("../src/index");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("consumer lifecycle", () => {
  let processObject;
  let exited;
  let connect;
  let startKafka;
  let beginShutdown;
  let stopKafka;
  let disconnectKafka;
  let waitForMessages;
  let processingFailed;
  let close;
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    exited = deferred();
    processObject = new EventEmitter();
    processObject.exit = jest.fn((code) => exited.resolve(code));
    connect = jest.fn().mockResolvedValue();
    startKafka = jest.fn().mockResolvedValue();
    beginShutdown = jest.fn();
    stopKafka = jest.fn().mockResolvedValue();
    disconnectKafka = jest.fn().mockResolvedValue();
    waitForMessages = jest.fn().mockResolvedValue();
    processingFailed = jest.fn().mockReturnValue(false);
    close = jest.fn().mockResolvedValue();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  function lifecycle(options = {}) {
    return createLifecycle({
      processObject, connect, startKafka, beginShutdown, stopKafka,
      disconnectKafka, waitForMessages, processingFailed, close, ...options,
    });
  }

  it("does not register signals or connect on import or construction", () => {
    lifecycle();
    expect(processObject.listenerCount("SIGTERM")).toBe(0);
    expect(processObject.listenerCount("SIGINT")).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"])("stops and disconnects Kafka before MongoDB on %s", async (signal) => {
    await lifecycle().start();
    processObject.emit(signal);
    expect(await exited.promise).toBe(0);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(stopKafka.mock.invocationCallOrder[0]).toBeLessThan(waitForMessages.mock.invocationCallOrder[0]);
    expect(waitForMessages.mock.invocationCallOrder[0]).toBeLessThan(disconnectKafka.mock.invocationCallOrder[0]);
    expect(disconnectKafka.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it("waits for in-flight work even if stop returns before it completes", async () => {
    const active = deferred();
    waitForMessages.mockReturnValue(active.promise);
    await lifecycle().start();
    processObject.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopKafka).toHaveBeenCalledTimes(1);
    expect(disconnectKafka).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    active.resolve();
    expect(await exited.promise).toBe(0);
  });

  it("performs cleanup once for repeated signals", async () => {
    const stopping = deferred();
    stopKafka.mockReturnValue(stopping.promise);
    await lifecycle().start();
    processObject.emit("SIGTERM");
    processObject.emit("SIGINT");
    stopping.resolve();
    expect(await exited.promise).toBe(0);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(stopKafka).toHaveBeenCalledTimes(1);
    expect(disconnectKafka).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stop", "stopKafka", "Failed to stop Kafka consumer:"],
    ["disconnect", "disconnectKafka", "Failed to disconnect Kafka consumer:"],
    ["MongoDB close", "close", "Failed to close consumer MongoDB connection:"],
  ])("exits with failure on %s error and attempts remaining cleanup", async (_label, target, message) => {
    const operations = { stopKafka, disconnectKafka, close };
    operations[target].mockRejectedValue(new Error("injected failure"));
    await lifecycle().start();
    processObject.emit("SIGTERM");
    expect(await exited.promise).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(message, "injected failure");
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnectKafka).toHaveBeenCalledTimes(1);
  });

  it("reports message processing failures during shutdown", async () => {
    processingFailed.mockReturnValue(true);
    await lifecycle().start();
    processObject.emit("SIGINT");
    expect(await exited.promise).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("A Kafka message failed during shutdown");
  });

  it.each(["stop", "drain", "disconnect", "MongoDB close"])(
    "bounds shutdown when %s hangs",
    async (stage) => {
      jest.useFakeTimers();
      const operations = { stop: stopKafka, drain: waitForMessages, disconnect: disconnectKafka, "MongoDB close": close };
      operations[stage].mockReturnValue(new Promise(() => {}));
      await lifecycle({ graceMs: 100 }).start();
      processObject.emit("SIGTERM");
      await jest.advanceTimersByTimeAsync(100);
      expect(await exited.promise).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("Consumer shutdown timed out; unfinished work may be replayed");
      if (stage === "stop" || stage === "drain") expect(close).not.toHaveBeenCalled();
    }
  );

  it.each(["database", "Kafka"])("cleans up after %s startup failure", async (stage) => {
    (stage === "database" ? connect : startKafka).mockRejectedValue(new Error("startup failure"));
    await lifecycle().start();
    expect(await exited.promise).toBe(1);
    expect(stopKafka).toHaveBeenCalledTimes(1);
    expect(disconnectKafka).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    if (stage === "database") expect(startKafka).not.toHaveBeenCalled();
  });

  it("waits for startup to settle and does not start Kafka after a signal", async () => {
    const pending = deferred();
    connect.mockReturnValue(pending.promise);
    const started = lifecycle().start();
    await Promise.resolve();
    processObject.emit("SIGTERM");
    pending.resolve();
    await started;
    expect(await exited.promise).toBe(0);
    expect(startKafka).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds shutdown during stuck startup", async () => {
    jest.useFakeTimers();
    connect.mockReturnValue(new Promise(() => {}));
    void lifecycle({ graceMs: 100 }).start();
    await Promise.resolve();
    processObject.emit("SIGTERM");
    await jest.advanceTimersByTimeAsync(100);
    expect(await exited.promise).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });
});
