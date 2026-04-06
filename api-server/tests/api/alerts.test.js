const request = require("supertest");
const app = require("../../src/app");

jest.mock("../../src/db", () => ({
  getDB: jest.fn(() => ({
    collection: jest.fn(() => ({
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          limit: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([
              {
                symbol: "BTC-USD",
                alertType: "SPIKE",
                message: "BTC-USD increased by 1.6%",
                percentChange: 1.6,
                timestamp: "2026-04-04T12:00:00Z",
              },
            ]),
          })),
        })),
      })),
    })),
  })),
}));

describe("GET /api/alerts", () => {
  it("should return alerts data", async () => {
    const response = await request(app).get("/api/alerts?limit=5");

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("success", true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toHaveProperty("symbol", "BTC-USD");
  });
});