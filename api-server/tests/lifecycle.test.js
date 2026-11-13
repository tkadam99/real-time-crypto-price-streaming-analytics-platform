const { EventEmitter } = require("events");
const http = require("http");
const express = require("express");
const { createLifecycle } = require("../src/index");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("API server lifecycle", () => {
  let processObject;
  let exited;
  let connect;
  let disconnect;
  let server;
  let application;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    exited = deferred();
    processObject = new EventEmitter();
    processObject.exit = jest.fn((code) => exited.resolve(code));
    connect = jest.fn().mockResolvedValue();
    disconnect = jest.fn().mockResolvedValue();
    server = new EventEmitter();
    server.listening = false;
    server.close = jest.fn((callback) => {
      server.listening = false;
      callback();
    });
    server.closeAllConnections = jest.fn();
    application = {
      listen: jest.fn(() => {
        queueMicrotask(() => {
          server.listening = true;
          server.emit("listening");
        });
        return server;
      }),
    };
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function lifecycle(options = {}) {
    return createLifecycle({
      application, connect, disconnect, processObject, port: 4321, ...options,
    });
  }

  it("does not register signals or listen until explicitly started", () => {
    lifecycle();
    expect(processObject.listenerCount("SIGINT")).toBe(0);
    expect(processObject.listenerCount("SIGTERM")).toBe(0);
    expect(application.listen).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"])("drains HTTP then closes MongoDB on %s", async (signal) => {
    const closed = deferred();
    server.close.mockImplementation((callback) => {
      server.listening = false;
      closed.promise.then(() => callback());
    });
    await lifecycle().start();
    processObject.emit(signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();

    closed.resolve();
    expect(await exited.promise).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("performs cleanup only once for repeated signals", async () => {
    const closed = deferred();
    server.close.mockImplementation((callback) => closed.promise.then(() => callback()));
    await lifecycle().start();
    processObject.emit("SIGTERM");
    processObject.emit("SIGINT");
    closed.resolve();

    expect(await exited.promise).toBe(0);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(processObject.exit).toHaveBeenCalledTimes(1);
  });

  it("reports HTTP close errors and still closes MongoDB", async () => {
    server.close.mockImplementation((callback) => callback(new Error("HTTP failure")));
    await lifecycle().start();
    processObject.emit("SIGTERM");

    expect(await exited.promise).toBe(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Failed to close API HTTP server:", "HTTP failure");
  });

  it("reports MongoDB close errors", async () => {
    disconnect.mockRejectedValue(new Error("MongoDB close failure"));
    await lifecycle().start();
    processObject.emit("SIGINT");

    expect(await exited.promise).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to close API MongoDB connection:", "MongoDB close failure"
    );
  });

  it("forces connections closed when the HTTP grace period expires", async () => {
    jest.useFakeTimers();
    server.close.mockImplementation(() => {});
    application.listen.mockImplementation(() => {
      Promise.resolve().then(() => {
        server.listening = true;
        server.emit("listening");
      });
      return server;
    });
    await lifecycle({ graceMs: 100, forcedCleanupMs: 50 }).start();
    processObject.emit("SIGTERM");
    await jest.advanceTimersByTimeAsync(100);

    expect(await exited.promise).toBe(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("bounds a MongoDB close that never resolves", async () => {
    jest.useFakeTimers();
    disconnect.mockImplementation(() => new Promise(() => {}));
    application.listen.mockImplementation(() => {
      Promise.resolve().then(() => {
        server.listening = true;
        server.emit("listening");
      });
      return server;
    });
    await lifecycle({ graceMs: 100, forcedCleanupMs: 50 }).start();
    processObject.emit("SIGINT");
    await jest.advanceTimersByTimeAsync(50);

    expect(await exited.promise).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("MongoDB shutdown timed out");
  });

  it("cleans up a partially acquired database after connection failure", async () => {
    connect.mockRejectedValue(new Error("connect failure"));
    await lifecycle().start();

    expect(await exited.promise).toBe(1);
    expect(application.listen).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Failed to start API server:", "connect failure");
  });

  it("cleans up MongoDB when the HTTP listener fails to bind", async () => {
    application.listen.mockImplementation(() => {
      queueMicrotask(() => server.emit("error", new Error("address in use")));
      return server;
    });
    await lifecycle().start();

    expect(await exited.promise).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Failed to start API server:", "address in use");
  });

  it("does not start listening if a signal arrives while connecting", async () => {
    const pending = deferred();
    connect.mockReturnValue(pending.promise);
    const started = lifecycle().start();
    await Promise.resolve();
    processObject.emit("SIGTERM");
    pending.resolve();
    await started;

    expect(await exited.promise).toBe(0);
    expect(application.listen).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("bounds shutdown while the initial connection is stuck", async () => {
    jest.useFakeTimers();
    connect.mockImplementation(() => new Promise(() => {}));
    void lifecycle({ graceMs: 100, forcedCleanupMs: 50 }).start();
    await Promise.resolve();
    processObject.emit("SIGTERM");
    await jest.advanceTimersByTimeAsync(100);

    expect(await exited.promise).toBe(1);
    expect(application.listen).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("cleans up a connection failure that occurs during signal shutdown", async () => {
    const pending = deferred();
    connect.mockReturnValue(pending.promise);
    const started = lifecycle().start();
    await Promise.resolve();
    processObject.emit("SIGTERM");
    pending.reject(new Error("connect failed during shutdown"));
    await started;

    expect(await exited.promise).toBe(1);
    expect(application.listen).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to start API server:", "connect failed during shutdown"
    );
  });

  it("closes a listener that finishes binding after a termination signal", async () => {
    application.listen.mockReturnValue(server);
    const started = lifecycle().start();
    await Promise.resolve();
    await Promise.resolve();
    expect(application.listen).toHaveBeenCalledTimes(1);
    processObject.emit("SIGTERM");
    server.listening = true;
    server.emit("listening");
    await started;

    expect(await exited.promise).toBe(0);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("stops accepting connections while a real HTTP request drains", async () => {
    const requestStarted = deferred();
    const finishRequest = deferred();
    const actualApp = express();
    actualApp.get("/", async (_req, res) => {
      requestStarted.resolve();
      await finishRequest.promise;
      res.end("finished");
    });
    let actualServer;
    application = {
      listen: () => {
        actualServer = actualApp.listen(0, "127.0.0.1");
        return actualServer;
      },
    };
    await lifecycle().start();
    const address = actualServer.address();
    const response = new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: address.port, path: "/" }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
    await requestStarted.promise;
    processObject.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(actualServer.listening).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    finishRequest.resolve();
    expect(await response).toBe("finished");
    expect(await exited.promise).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
