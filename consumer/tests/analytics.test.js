const {
  calculatePercentChange,
  calculateMovingAverage,
  shouldCreateAlert,
  buildAlert,
} = require("../src/analytics");

describe("Analytics Unit Tests", () => {
  describe("calculateMovingAverage", () => {
    it("should return 0 for an empty array", () => {
      expect(calculateMovingAverage([])).toBe(0);
    });

    it("should return the same value for a single-element array", () => {
      expect(calculateMovingAverage([50])).toBe(50);
    });

    it("should calculate average for multiple values", () => {
      expect(calculateMovingAverage([10, 20, 30])).toBe(20);
    });

    it("should calculate decimal average correctly", () => {
      expect(calculateMovingAverage([1.5, 2.5, 3.5])).toBe(2.5);
    });
  });

  describe("calculatePercentChange", () => {
    it("should return 0 if previousPrice is null", () => {
      expect(calculatePercentChange(null, 100)).toBe(0);
    });

    it("should return 0 if previousPrice is undefined", () => {
      expect(calculatePercentChange(undefined, 100)).toBe(0);
    });

    it("should return 0 if previousPrice is 0", () => {
      expect(calculatePercentChange(0, 100)).toBe(0);
    });

    it("should calculate positive percent change correctly", () => {
      expect(calculatePercentChange(100, 110)).toBe(10);
    });

    it("should calculate negative percent change correctly", () => {
      expect(calculatePercentChange(100, 90)).toBe(-10);
    });

    it("should return 0 when prices are equal", () => {
      expect(calculatePercentChange(100, 100)).toBe(0);
    });
  });

  describe("shouldCreateAlert", () => {
    it("should return false when change is below threshold", () => {
      expect(shouldCreateAlert(1.0)).toBe(false);
    });

    it("should return true when change is above positive threshold", () => {
      expect(shouldCreateAlert(2.0)).toBe(true);
    });

    it("should return true when change is above negative threshold in absolute value", () => {
      expect(shouldCreateAlert(-2.0)).toBe(true);
    });

    it("should return true when change is exactly at threshold", () => {
      expect(shouldCreateAlert(1.5)).toBe(true);
    });
  });

  describe("buildAlert", () => {
    it("should build an increase alert correctly", () => {
      const alert = buildAlert(
        "BTC-USD",
        2.5,
        102.5,
        100,
        "2026-04-04T12:00:00Z"
      );

      expect(alert).toHaveProperty("symbol", "BTC-USD");
      expect(alert).toHaveProperty("alertType", "SPIKE");
      expect(alert).toHaveProperty("percentChange", 2.5);
      expect(alert).toHaveProperty("timestamp", "2026-04-04T12:00:00Z");
      expect(alert.message).toContain("increased");
    });

    it("should build a decrease alert correctly", () => {
      const alert = buildAlert(
        "ETH-USD",
        -3.2,
        96.8,
        100,
        "2026-04-04T12:00:00Z"
      );

      expect(alert).toHaveProperty("symbol", "ETH-USD");
      expect(alert).toHaveProperty("alertType", "SPIKE");
      expect(alert).toHaveProperty("percentChange", -3.2);
      expect(alert).toHaveProperty("timestamp", "2026-04-04T12:00:00Z");
      expect(alert.message).toContain("decreased");
    });
  });
});