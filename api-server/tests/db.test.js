jest.mock("mongodb", () => ({ MongoClient: jest.fn() }));

describe("API MongoDB lifecycle", () => {
  let connect;
  let close;
  let client;
  let dbModule;
  let logSpy;

  beforeEach(() => {
    jest.resetModules();
    connect = jest.fn().mockResolvedValue();
    close = jest.fn().mockResolvedValue();
    client = { connect, close, db: jest.fn().mockReturnValue({ name: "test" }) };
    require("mongodb").MongoClient.mockImplementation(() => client);
    dbModule = require("../src/db");
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => logSpy.mockRestore());

  it("releases the client after an initial connection failure", async () => {
    const failure = new Error("connection failure");
    connect.mockRejectedValue(failure);

    await expect(dbModule.connectDB()).rejects.toBe(failure);
    await dbModule.closeDB();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => dbModule.getDB()).toThrow("Database not connected");
  });

  it("closes a successful connection only once and clears the shared handle", async () => {
    const db = await dbModule.connectDB();
    expect(dbModule.getDB()).toBe(db);
    expect(await dbModule.connectDB()).toBe(db);
    expect(connect).toHaveBeenCalledTimes(1);

    await dbModule.closeDB();
    await dbModule.closeDB();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => dbModule.getDB()).toThrow("Database not connected");
  });

  it("propagates close errors", async () => {
    const failure = new Error("close failed");
    close.mockRejectedValue(failure);
    await dbModule.connectDB();

    await expect(dbModule.closeDB()).rejects.toBe(failure);
  });
});
