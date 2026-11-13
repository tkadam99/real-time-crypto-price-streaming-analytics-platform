const {
  createLivePriceTracker,
  calculatePercentChange,
  calculateMovingAverage,
  shouldCreateAlert,
  buildAlert,
} = require("../src/analytics");

describe("Analytics Unit Tests", () => {
  describe("createLivePriceTracker", () => {
    const trackerOptions = {
      windowMs: 60_000,
      baselineToleranceMs: 10_000,
      cooldownMs: 300_000,
    };

    it("uses a recent event at the comparison-window boundary as the baseline", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      tracker.recordPrice("BTC-USD", 100, "2026-04-04T12:00:00.000Z");

      expect(
        tracker.getBaseline("BTC-USD", "2026-04-04T12:01:00.000Z")
      ).toEqual({
        price: 100,
        timestamp: Date.parse("2026-04-04T12:00:00.000Z"),
      });
    });

    it("skips a baseline that is outside the configured tolerance", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      tracker.recordPrice("BTC-USD", 100, "2026-04-04T11:59:49.999Z");

      expect(
        tracker.getBaseline("BTC-USD", "2026-04-04T12:01:00.000Z")
      ).toBeNull();
    });

    it("does not use an event newer than the comparison target", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      tracker.recordPrice("BTC-USD", 101, "2026-04-04T12:00:01.000Z");

      expect(
        tracker.getBaseline("BTC-USD", "2026-04-04T12:01:00.000Z")
      ).toBeNull();
    });

    it("tracks the previous price independently for each symbol", () => {
      const tracker = createLivePriceTracker(trackerOptions);

      tracker.recordPrice("BTC-USD", 100, "2026-04-04T12:00:00.000Z");
      tracker.recordPrice("ETH-USD", 20, "2026-04-04T12:00:00.000Z");
      tracker.recordPrice("BTC-USD", 101, "2026-04-04T12:00:10.000Z");

      expect(
        tracker.getBaseline("BTC-USD", "2026-04-04T12:01:10.000Z").price
      ).toBe(101);
      expect(
        tracker.getBaseline("ETH-USD", "2026-04-04T12:01:00.000Z").price
      ).toBe(20);
    });

    it("allows events to be recorded out of timestamp order", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      tracker.recordPrice("BTC-USD", 101, "2026-04-04T12:00:01.000Z");
      tracker.recordPrice("BTC-USD", 100, "2026-04-04T12:00:00.000Z");

      expect(
        tracker.getBaseline("BTC-USD", "2026-04-04T12:01:01.000Z").price
      ).toBe(101);
    });

    it("applies cooldown independently per symbol and allows an alert at expiry", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      const alertTime = "2026-04-04T12:00:00.000Z";
      tracker.recordAlert("BTC-USD", alertTime);

      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:04:59.999Z")
      ).toBe(true);
      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:05:00.000Z")
      ).toBe(false);
      expect(
        tracker.isOnCooldown("ETH-USD", "2026-04-04T12:00:01.000Z")
      ).toBe(false);
    });

    it("advances cooldown to a newer alert and keeps the expiry based on that alert", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      tracker.recordAlert("BTC-USD", "2026-04-04T12:02:00.000Z", "old-alert");
      tracker.recordAlert("BTC-USD", "2026-04-04T12:08:00.000Z", "new-alert");

      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:12:59.999Z")
      ).toBe(true);
      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:13:00.000Z")
      ).toBe(false);
    });

    it("does not rewind cooldown when an older alert is replayed", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      const olderAlert = "2026-04-04T12:02:00.000Z";
      tracker.recordAlert("BTC-USD", olderAlert, "older-alert");
      tracker.recordAlert("BTC-USD", "2026-04-04T12:08:00.000Z", "newer-alert");
      tracker.recordAlert("BTC-USD", olderAlert, "older-alert");

      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:09:00.000Z", "next-event")
      ).toBe(true);
      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:12:59.999Z", "next-event")
      ).toBe(true);
      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:13:00.000Z", "next-event")
      ).toBe(false);
    });

    it("does not change cooldown when the same alert is recorded again", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      const alertTime = "2026-04-04T12:08:00.000Z";
      tracker.recordAlert("BTC-USD", alertTime, "same-alert");
      tracker.recordAlert("BTC-USD", alertTime, "same-alert");

      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:12:59.999Z", "next-event")
      ).toBe(true);
      expect(
        tracker.isOnCooldown("BTC-USD", "2026-04-04T12:13:00.000Z", "next-event")
      ).toBe(false);
    });

    it("tracks cooldown independently for BTC, ETH, and SOL", () => {
      const tracker = createLivePriceTracker(trackerOptions);
      tracker.recordAlert("BTC-USD", "2026-04-04T12:02:00.000Z");
      tracker.recordAlert("ETH-USD", "2026-04-04T12:08:00.000Z");
      tracker.recordAlert("SOL-USD", "2026-04-04T12:09:00.000Z");

      expect(tracker.isOnCooldown("BTC-USD", "2026-04-04T12:07:00.000Z")).toBe(false);
      expect(tracker.isOnCooldown("ETH-USD", "2026-04-04T12:10:00.000Z")).toBe(true);
      expect(tracker.isOnCooldown("SOL-USD", "2026-04-04T12:10:00.000Z")).toBe(true);
    });
  });

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
      expect(shouldCreateAlert(0.49)).toBe(false);
    });

    it("should return true when change is above positive threshold", () => {
      expect(shouldCreateAlert(0.6)).toBe(true);
    });

    it("should return true when change is above negative threshold in absolute value", () => {
      expect(shouldCreateAlert(-0.6)).toBe(true);
    });

    it("should return true when change is exactly at threshold", () => {
      expect(shouldCreateAlert(0.5)).toBe(true);
    });
  });

  describe("buildAlert", () => {
    it("should build an increase alert correctly", () => {
      const alert = buildAlert(
        "BTC-USD",
        2.5,
        102.5,
        100,
        "2026-04-04T12:00:00Z",
        "2026-04-04T11:59:00Z"
      );

      expect(alert).toHaveProperty("symbol", "BTC-USD");
      expect(alert).toHaveProperty("alertType", "SPIKE");
      expect(alert).toHaveProperty("percentChange", 2.5);
      expect(alert).toHaveProperty("timestamp", "2026-04-04T12:00:00Z");
      expect(alert).toHaveProperty("previousPrice", 100);
      expect(alert).toHaveProperty("currentPrice", 102.5);
      expect(alert).toHaveProperty("comparisonTimestamp", "2026-04-04T11:59:00Z");
      expect(alert).toHaveProperty("windowMs", 60_000);
      expect(alert.message).toContain("increased");
      expect(alert.message).toContain("over 1 minute");
    });

    it("should build a decrease alert correctly", () => {
      const alert = buildAlert(
        "ETH-USD",
        -3.2,
        96.8,
        100,
        "2026-04-04T12:00:00Z",
        "2026-04-04T11:59:00Z"
      );

      expect(alert).toHaveProperty("symbol", "ETH-USD");
      expect(alert).toHaveProperty("alertType", "SPIKE");
      expect(alert).toHaveProperty("percentChange", -3.2);
      expect(alert).toHaveProperty("timestamp", "2026-04-04T12:00:00Z");
      expect(alert.message).toContain("decreased");
    });
  });
});