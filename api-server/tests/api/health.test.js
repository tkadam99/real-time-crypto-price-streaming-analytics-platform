const request = require("supertest");

jest.mock("../../src/db", () => ({ getDB: jest.fn() }));

describe("GET /api/health", () => {
  let app;
  let getDB;
  let command;
  let errorSpy;

  beforeEach(() => {
    jest.resetModules();
    ({ getDB } = require("../../src/db"));
    app = require("../../src/app");
    command = jest.fn().mockResolvedValue({ ok: 1 });
    getDB.mockReturnValue({ command });
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it("pings the shared database and preserves the successful response", async () => {
    const response = await request(app).get("/api/health");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "api-server",
      Timestamp: expect.any(String),
    });
    expect(Number.isFinite(Date.parse(response.body.Timestamp))).toBe(true);
    expect(getDB).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      { ping: 1 },
      { timeoutMS: 1000, signal: expect.any(AbortSignal) }
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 503 when the shared database is unavailable", async () => {
    getDB.mockImplementation(() => {
      throw new Error("Database not connected");
    });

    const response = await request(app).get("/api/health");

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      service: "api-server",
      Timestamp: expect.any(String),
    });
    expect(command).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ping failure", new Error("ping failed at mongodb://user:secret@db.internal")],
    ["timeout", new Error("MongoOperationTimeoutError: db.internal")],
    ["connection failure", new Error("connection refused to db.internal")],
  ])("returns a sanitized 503 on %s", async (_description, failure) => {
    command.mockRejectedValue(failure);

    const response = await request(app).get("/api/health");

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      service: "api-server",
      Timestamp: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain(failure.message);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|db\.internal|stack/i);
    expect(errorSpy).toHaveBeenCalledWith("API health check failed:", failure.message);
  });

  it("rejects a ping response that does not report success", async () => {
    command.mockResolvedValue({ ok: 0 });

    const response = await request(app).get("/api/health");

    expect(response.statusCode).toBe(503);
    expect(response.body.status).toBe("unavailable");
  });

  it("aborts a stalled ping and returns 503", async () => {
    command.mockImplementation((_query, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const response = await request(app).get("/api/health");

    expect(response.statusCode).toBe(503);
    expect(response.body.status).toBe("unavailable");
    expect(command.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("reports recovery when a later ping succeeds", async () => {
    command.mockRejectedValueOnce(new Error("database down"));

    expect((await request(app).get("/api/health")).statusCode).toBe(503);
    const response = await request(app).get("/api/health");
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("limits repeated failure logs and logs again after the interval", async () => {
    let now = 100_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    command.mockRejectedValue(new Error("database down"));

    expect((await request(app).get("/api/health")).statusCode).toBe(503);
    now += 59_999;
    expect((await request(app).get("/api/health")).statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    now += 1;
    expect((await request(app).get("/api/health")).statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
