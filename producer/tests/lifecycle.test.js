const { EventEmitter } = require("events");
const { createLifecycle } = require("../src/index");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("producer lifecycle", () => {
  let processObject;
  let exited;
  let connect;
  let disconnect;
  let startStream;
  let beginShutdown;
  let stopStream;
  let terminateStream;
  let drain;
  let publishFailed;
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    exited = deferred();
    processObject = new EventEmitter();
    processObject.exit = jest.fn(exited.resolve);
    connect = jest.fn().mockResolvedValue();
    disconnect = jest.fn().mockResolvedValue();
    startStream = jest.fn();
    beginShutdown = jest.fn();
    stopStream = jest.fn().mockResolvedValue();
    terminateStream = jest.fn();
    drain = jest.fn().mockResolvedValue();
    publishFailed = jest.fn().mockReturnValue(false);
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
      processObject, connect, disconnect, startStream, beginShutdown,
      stopStream, terminateStream, drain, publishFailed, ...options,
    });
  }

  it("does not start connections or register signals on construction", () => {
    lifecycle();
    expect(connect).not.toHaveBeenCalled();
    expect(processObject.listenerCount("SIGINT")).toBe(0);
    expect(processObject.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"])("closes and drains before Kafka disconnect on %s", async (signal) => {
    const closed = deferred();
    const pending = deferred();
    stopStream.mockReturnValue(closed.promise);
    drain.mockReturnValue(pending.promise);
    await lifecycle().start();
    processObject.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    closed.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(drain).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    pending.resolve();
    expect(await exited.promise).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate cleanup on repeated signals", async () => {
    const closed = deferred();
    stopStream.mockReturnValue(closed.promise);
    await lifecycle().start();
    processObject.emit("SIGINT");
    processObject.emit("SIGTERM");
    closed.resolve();
    expect(await exited.promise).toBe(0);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("reports failed outstanding publishes after draining", async () => {
    publishFailed.mockReturnValue(true);
    await lifecycle().start();
    processObject.emit("SIGTERM");
    expect(await exited.promise).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("A Kafka publish failed during shutdown");
  });

  it("terminates a WebSocket on close failure and still disconnects", async () => {
    stopStream.mockRejectedValue(new Error("close failed"));
    await lifecycle().start();
    processObject.emit("SIGTERM");
    expect(await exited.promise).toBe(1);
    expect(terminateStream).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("reports Kafka disconnect failures", async () => {
    disconnect.mockRejectedValue(new Error("disconnect failed"));
    await lifecycle().start();
    processObject.emit("SIGINT");
    expect(await exited.promise).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("Failed to disconnect Kafka producer:", "disconnect failed");
  });

  it.each(["startup", "WebSocket", "publishes", "Kafka disconnect"])(
    "bounds shutdown when %s hangs",
    async (stage) => {
      jest.useFakeTimers();
      const operations = { startup: connect, WebSocket: stopStream, publishes: drain, "Kafka disconnect": disconnect };
      operations[stage].mockReturnValue(new Promise(() => {}));
      const started = lifecycle({ graceMs: 100 }).start();
      if (stage === "startup") await Promise.resolve();
      else await started;
      processObject.emit("SIGTERM");
      await jest.advanceTimersByTimeAsync(100);
      expect(await exited.promise).toBe(1);
      expect(terminateStream).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("Producer shutdown timed out; outstanding publishes may be lost");
      if (stage === "publishes") expect(disconnect).not.toHaveBeenCalled();
    }
  );

  it.each(["Kafka connect", "WebSocket start"])("cleans up after %s failure", async (stage) => {
    if (stage === "Kafka connect") connect.mockRejectedValue(new Error("startup failure"));
    else startStream.mockImplementation(() => { throw new Error("startup failure"); });
    await lifecycle().start();
    expect(await exited.promise).toBe(1);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not start Coinbase if shutdown begins while Kafka is connecting", async () => {
    const connecting = deferred();
    connect.mockReturnValue(connecting.promise);
    const started = lifecycle().start();
    await Promise.resolve();
    processObject.emit("SIGTERM");
    connecting.resolve();
    await started;
    expect(await exited.promise).toBe(0);
    expect(startStream).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
