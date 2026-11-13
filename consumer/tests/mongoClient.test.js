jest.mock("mongodb", () => ({ MongoClient: jest.fn() }));

describe("consumer MongoDB lifecycle", () => {
  let connect;
  let close;
  let mongo;
  let logSpy;

  beforeEach(() => {
    jest.resetModules();
    connect = jest.fn().mockResolvedValue();
    close = jest.fn().mockResolvedValue();
    const client = { connect, close, db: jest.fn().mockReturnValue({ name: "test" }) };
    require("mongodb").MongoClient.mockImplementation(() => client);
    mongo = require("../src/mongoClient");
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => logSpy.mockRestore());

  it("propagates connection failures and permits cleanup of a partially connected client", async () => {
    const failure = new Error("connect failed");
    connect.mockRejectedValue(failure);
    await expect(mongo.connectDB()).rejects.toBe(failure);
    await mongo.closeDB();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => mongo.getDB()).toThrow("Database not connected");
  });

  it("reuses and closes the shared connection", async () => {
    const db = await mongo.connectDB();
    expect(await mongo.connectDB()).toBe(db);
    expect(mongo.getDB()).toBe(db);
    await mongo.closeDB();
    await mongo.closeDB();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => mongo.getDB()).toThrow("Database not connected");
  });

  it("propagates MongoDB close errors", async () => {
    const failure = new Error("close failed");
    close.mockRejectedValue(failure);
    await mongo.connectDB();
    await expect(mongo.closeDB()).rejects.toBe(failure);
  });
});
