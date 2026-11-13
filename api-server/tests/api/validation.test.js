const request = require("supertest");
const app = require("../../src/app");
const { getDB } = require("../../src/db");

jest.mock("../../src/db", () => ({ getDB: jest.fn() }));

describe("API query and symbol validation", () => {
  let cursor;
  let collection;
  let errorSpy;
  const history = [{
    symbol: "BTC-USD",
    price: 100,
    timestamp: "2026-04-04T12:00:00Z",
    receivedAt: "2026-04-04T12:00:01Z",
  }];
  const alerts = [{
    symbol: "BTC-USD",
    alertType: "SPIKE",
    timestamp: "2026-04-04T12:00:00Z",
  }];

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    cursor = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      project: jest.fn().mockReturnThis(),
      toArray: jest.fn(),
    };
    collection = { find: jest.fn().mockReturnValue(cursor) };
    getDB.mockReturnValue({ collection: jest.fn().mockReturnValue(collection) });
  });

  afterEach(() => errorSpy.mockRestore());

  it.each(["BTC-USD", "ETH-USD", "SOL-USD"])(
    "queries history using the supported symbol %s and default limit",
    async (symbol) => {
      cursor.toArray.mockResolvedValue(history);
      const response = await request(app).get(`/api/prices/history/${symbol}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, symbol, count: 1, data: history });
      expect(collection.find).toHaveBeenCalledWith({ symbol });
      expect(cursor.sort).toHaveBeenCalledWith({ timestamp: -1 });
      expect(cursor.limit).toHaveBeenCalledWith(20);
      expect(cursor.project).toHaveBeenCalledWith({
        _id: 0, symbol: 1, price: 1, timestamp: 1, receivedAt: 1,
      });
    }
  );

  it.each(["DOGE-USD", "btc-usd", "BTC", "%20BTC-USD", "%7B%22%24ne%22%3Anull%7D"])(
    "rejects unsupported symbol %s before accessing the database",
    async (symbol) => {
      const response = await request(app).get(`/api/prices/history/${symbol}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        message: "Unsupported symbol; expected BTC-USD, ETH-USD, or SOL-USD",
      });
      expect(getDB).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["/api/prices/history/BTC-USD", history, 20],
    ["/api/alerts", alerts, 20],
  ])("returns the existing shape for %s with an omitted limit", async (path, data, defaultLimit) => {
    cursor.toArray.mockResolvedValue(data);
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, count: 1, data });
    expect(cursor.limit).toHaveBeenCalledWith(defaultLimit);
  });

  it.each([
    ["/api/prices/history/BTC-USD", 1],
    ["/api/prices/history/BTC-USD", 10000],
    ["/api/alerts", 1],
    ["/api/alerts", 10000],
  ])("passes the explicit limit for %s (%i) to MongoDB", async (path, limit) => {
    cursor.toArray.mockResolvedValue([]);
    const response = await request(app).get(path).query({ limit });

    expect(response.status).toBe(200);
    expect(cursor.limit).toHaveBeenCalledWith(limit);
    if (path === "/api/alerts") {
      expect(collection.find).toHaveBeenCalledWith({}, { projection: { _id: 0 } });
      expect(cursor.sort).toHaveBeenCalledWith({ timestamp: -1 });
      expect(response.body).toEqual({ success: true, count: 0, data: [] });
    }
  });

  const invalidLimits = [
    "0", "-1", "1.5", "NaN", "Infinity", "", " ", "abc", "10001",
    "9007199254740992", "1e2", "+2", " 2", "2 ", "0x10",
  ];

  describe.each(["/api/prices/history/BTC-USD", "/api/alerts"])("%s", (path) => {
    it.each(invalidLimits)("rejects invalid limit %j", async (limit) => {
      const response = await request(app).get(path).query({ limit });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        message: "limit must be an integer between 1 and 10000",
      });
      expect(getDB).not.toHaveBeenCalled();
    });

    it("rejects repeated limit parameters", async () => {
      const response = await request(app).get(`${path}?limit=1&limit=2`);

      expect(response.status).toBe(400);
      expect(getDB).not.toHaveBeenCalled();
    });

    it("rejects nested limit parameters instead of using the default", async () => {
      const response = await request(app).get(path).query({ "limit[$gt]": "0" });

      expect(response.status).toBe(400);
      expect(getDB).not.toHaveBeenCalled();
    });

    it("returns a generic server error when the database fails", async () => {
      const failure = new Error("sensitive connection detail");
      cursor.toArray.mockRejectedValue(failure);
      const response = await request(app).get(path);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        message: path === "/api/alerts"
          ? "Failed to fetch alerts"
          : "Failed to fetch price history",
      });
      expect(JSON.stringify(response.body)).not.toContain(failure.message);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure.message);
    });
  });
});
