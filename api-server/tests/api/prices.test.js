const request = require("supertest");
const app = require("../../src/app");

const mockToArray = jest.fn();

jest.mock("../../src/db", () => ({
  getDB: jest.fn(() => ({
    collection: jest.fn((name) => {
      if (name === "metrics") {
        return {
          find: jest.fn(() => ({
            sort: jest.fn(() => ({
              toArray: jest.fn().mockResolvedValue([
                {
                  symbol: "BTC-USD",
                  latestPrice: 68000,
                  updatedAt: "2026-04-04T12:00:00Z",
                },
              ]),
            })),
          })),
        };
      }

      if (name === "price_events") {
        return {
          find: jest.fn(() => ({
            sort: jest.fn(() => ({
              limit: jest.fn(() => ({
                project: jest.fn(() => ({
                  toArray: jest.fn().mockResolvedValue([
                    {
                      symbol: "BTC-USD",
                      price: 68000,
                      timestamp: "2026-04-04T12:00:00Z",
                      receivedAt: "2026-04-04T12:00:01Z",
                    },
                  ]),
                })),
              })),
            })),
          })),
        };
      }

      return {};
    }),
  })),
}));

describe("GET /api/prices/latest", () => {
  it("should return latest prices", async () => {
    const response = await request(app).get("/api/prices/latest");

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("success", true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toHaveProperty("symbol", "BTC-USD");
  });
});

describe("GET /api/prices/history/:symbol", () => {
  it("should return price history for a symbol", async () => {
    const response = await request(app).get("/api/prices/history/BTC-USD?limit=10");

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("success", true);
    expect(response.body).toHaveProperty("symbol", "BTC-USD");
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});