const request = require("supertest");
const app = require("../../src/app");
const { getDB } = require("../../src/db");

jest.mock("../../src/db", () => ({ getDB: jest.fn() }));

describe("GET /api/prices/current", () => {
  let cursor, collection, db, errorSpy;
  const snapshot = {
    _id: "BTC-USD",
    symbol: "BTC-USD",
    price: 68000.25,
    marketTimestamp: "2026-04-04T13:00:00.123456789+01:00",
    receivedAt: new Date("2026-04-04T12:00:01.234Z"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    cursor = { sort: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([snapshot]) };
    collection = { find: jest.fn().mockReturnValue(cursor) };
    db = { collection: jest.fn().mockReturnValue(collection) };
    getDB.mockReturnValue(db);
  });
  afterEach(() => errorSpy.mockRestore());

  it("reads only supported current-price identities and preserves the exact market timestamp", async () => {
    const response = await request(app).get("/api/prices/current");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      count: 1,
      data: [{
        symbol: "BTC-USD", price: 68000.25,
        marketTimestamp: "2026-04-04T13:00:00.123456789+01:00",
        receivedAt: "2026-04-04T12:00:01.234Z",
      }],
    });
    expect(db.collection).toHaveBeenCalledTimes(1);
    expect(db.collection).toHaveBeenCalledWith("current_prices");
    expect(collection.find).toHaveBeenCalledWith(
      { _id: { $in: ["BTC-USD", "ETH-USD", "SOL-USD"] } },
      { projection: { _id: 1, symbol: 1, price: 1, marketTimestamp: 1, receivedAt: 1 } }
    );
    expect(cursor.sort).toHaveBeenCalledWith({ _id: 1 });
  });

  it("returns an empty result without falling back to historical metrics", async () => {
    cursor.toArray.mockResolvedValue([]);
    const response = await request(app).get("/api/prices/current");
    expect(response.body).toEqual({ success: true, count: 0, data: [] });
    expect(db.collection).toHaveBeenCalledTimes(1);
    expect(db.collection).toHaveBeenCalledWith("current_prices");
  });

  it("omits missing symbols and returns existing data even without a running consumer", async () => {
    const response = await request(app).get("/api/prices/current");
    expect(response.status).toBe(200);
    expect(response.body.data.map((item) => item.symbol)).toEqual(["BTC-USD"]);
  });

  it.each([
    ["missing symbol", { ...snapshot, symbol: undefined }],
    ["mismatched identity", { ...snapshot, symbol: "ETH-USD" }],
    ["invalid price", { ...snapshot, price: "68000" }],
    ["zero price", { ...snapshot, price: 0 }],
    ["infinite price", { ...snapshot, price: Infinity }],
    ["missing timestamp", { ...snapshot, marketTimestamp: undefined }],
    ["invalid calendar date", { ...snapshot, marketTimestamp: "2026-02-29T00:00:00Z" }],
    ["too much timestamp precision", { ...snapshot, marketTimestamp: "2026-01-01T00:00:00.1234567891Z" }],
    ["invalid timestamp offset", { ...snapshot, marketTimestamp: "2026-01-01T00:00:00+25:00" }],
    ["missing receipt time", { ...snapshot, receivedAt: undefined }],
    ["invalid receipt date", { ...snapshot, receivedAt: new Date(NaN) }],
    ["string receipt time", { ...snapshot, receivedAt: "2026-04-04T12:00:01Z" }],
  ])("returns an error for %s instead of a partial result", async (_label, invalid) => {
    cursor.toArray.mockResolvedValue([snapshot, invalid]);
    const response = await request(app).get("/api/prices/current");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: "Failed to fetch current prices" });
    expect(errorSpy).toHaveBeenCalledWith("Error fetching current prices:", "Invalid current-price snapshot");
  });

  it("reports MongoDB failures", async () => {
    cursor.toArray.mockRejectedValue(new Error("database unavailable"));
    const response = await request(app).get("/api/prices/current");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: "Failed to fetch current prices" });
    expect(errorSpy).toHaveBeenCalledWith("Error fetching current prices:", "database unavailable");
  });

  it.each(["symbol=BTC-USD", "limit=1", "symbol%5B%24ne%5D=BTC-USD"])(
    "rejects unsupported query parameters before reading the database",
    async (query) => {
      const response = await request(app).get(`/api/prices/current?${query}`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ success: false, message: "Query parameters are not supported" });
      expect(getDB).not.toHaveBeenCalled();
    }
  );
});
