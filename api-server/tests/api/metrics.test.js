const request = require("supertest");
const app = require("../../src/app");

jest.mock("../../src/db", () => ({
  getDB: jest.fn(() => ({
    collection: jest.fn(() => ({
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([
            {
              symbol: "BTC-USD",
              latestPrice: 68000,
              previousPrice: 67950,
              movingAverage: 67980,
              percentChange: 0.0736,
              updatedAt: "2026-04-04T12:00:00Z",
            },
          ]),
        })),
      })),
    })),
  })),
}));

describe("GET /api/metrics", () => {
  it("should return metrics data", async () => {
    const response = await request(app).get("/api/metrics");

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("success", true);
    expect(response.body).toHaveProperty("count", 1);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toHaveProperty("symbol", "BTC-USD");
  });
});