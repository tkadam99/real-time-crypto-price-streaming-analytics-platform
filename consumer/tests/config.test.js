const numericVariables = [
  "ALERT_THRESHOLD_PERCENT",
  "ALERT_WINDOW_MS",
  "ALERT_BASELINE_TOLERANCE_MS",
  "ALERT_COOLDOWN_MS",
  "MOVING_AVERAGE_WINDOW",
  "MAX_EVENTS_PER_SYMBOL",
];
const configVariables = [...numericVariables, "CONSUMER_PROCESSING_TIMINGS", "ALERT_DECISION_CLEANUP_ENABLED"];

function loadConfig(overrides = {}) {
  const previousValues = Object.fromEntries(
    configVariables.map((name) => [name, process.env[name]])
  );
  let config;

  try {
    for (const name of configVariables) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[name] = value;
    }

    jest.isolateModules(() => {
      jest.doMock("dotenv", () => ({ config: jest.fn() }));
      config = require("../src/config");
    });
  } finally {
    jest.dontMock("dotenv");
    for (const [name, value] of Object.entries(previousValues)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  return config;
}

describe("consumer numerical configuration", () => {
  it("uses the existing defaults when numerical environment variables are missing", () => {
    const config = loadConfig();

    expect(config).toMatchObject({
      alertThresholdPercent: 0.5,
      alertWindowMs: 60_000,
      alertBaselineToleranceMs: 10_000,
      alertCooldownMs: 300_000,
      movingAverageWindow: 5,
      maxEventsPerSymbol: 10_000,
      processingTimings: false,
      decisionCleanupEnabled: false,
    });
  });

  it("accepts existing configured values", () => {
    const config = loadConfig({
      ALERT_THRESHOLD_PERCENT: "0.5",
      ALERT_WINDOW_MS: "60000",
      ALERT_BASELINE_TOLERANCE_MS: "10000",
      ALERT_COOLDOWN_MS: "300000",
      MOVING_AVERAGE_WINDOW: "5",
      MAX_EVENTS_PER_SYMBOL: "10000",
    });

    expect(config.alertThresholdPercent).toBe(0.5);
    expect(config.alertWindowMs).toBe(60_000);
    expect(config.alertBaselineToleranceMs).toBe(10_000);
    expect(config.alertCooldownMs).toBe(300_000);
    expect(config.movingAverageWindow).toBe(5);
    expect(config.maxEventsPerSymbol).toBe(10_000);
  });

  it.each([["true", true], ["false", false]])(
    "configures processing timings with %s",
    (value, expected) => {
      expect(loadConfig({ CONSUMER_PROCESSING_TIMINGS: value }).processingTimings).toBe(expected);
    }
  );

  it("rejects an invalid processing timings setting", () => {
    expect(() => loadConfig({ CONSUMER_PROCESSING_TIMINGS: "yes" })).toThrow(
      'CONSUMER_PROCESSING_TIMINGS must be "true" or "false"'
    );
  });

  it.each([["true", true], ["false", false]])("configures cleanup with %s", (value, expected) => {
    expect(loadConfig({ ALERT_DECISION_CLEANUP_ENABLED: value }).decisionCleanupEnabled).toBe(expected);
  });

  it.each(["", "TRUE", "yes", "1"])("rejects invalid cleanup setting %s", (value) => {
    expect(() => loadConfig({ ALERT_DECISION_CLEANUP_ENABLED: value })).toThrow(
      'ALERT_DECISION_CLEANUP_ENABLED must be "true" or "false"'
    );
  });

  it("accepts positive fractional threshold and duration values", () => {
    const config = loadConfig({
      ALERT_THRESHOLD_PERCENT: "0.25",
      ALERT_WINDOW_MS: "1500.5",
      ALERT_BASELINE_TOLERANCE_MS: "0.5",
      ALERT_COOLDOWN_MS: "250.5",
    });

    expect(config.alertThresholdPercent).toBe(0.25);
    expect(config.alertWindowMs).toBe(1500.5);
    expect(config.alertBaselineToleranceMs).toBe(0.5);
    expect(config.alertCooldownMs).toBe(250.5);
  });

  it("accepts zero for baseline tolerance and cooldown", () => {
    const config = loadConfig({
      ALERT_BASELINE_TOLERANCE_MS: "0",
      ALERT_COOLDOWN_MS: "0",
    });

    expect(config.alertBaselineToleranceMs).toBe(0);
    expect(config.alertCooldownMs).toBe(0);
  });

  it.each([
    ["MOVING_AVERAGE_WINDOW", "0", "a positive safe integer"],
    ["MOVING_AVERAGE_WINDOW", "-1", "a positive safe integer"],
    ["MOVING_AVERAGE_WINDOW", "1.5", "a positive safe integer"],
    ["MOVING_AVERAGE_WINDOW", "NaN", "a positive safe integer"],
    ["MOVING_AVERAGE_WINDOW", "Infinity", "a positive safe integer"],
    ["MOVING_AVERAGE_WINDOW", "not-a-number", "a positive safe integer"],
    ["MAX_EVENTS_PER_SYMBOL", "0", "a positive safe integer"],
    ["MAX_EVENTS_PER_SYMBOL", "-1", "a positive safe integer"],
    ["MAX_EVENTS_PER_SYMBOL", "2.5", "a positive safe integer"],
    ["MAX_EVENTS_PER_SYMBOL", "Infinity", "a positive safe integer"],
  ])("rejects invalid integer setting %s=%s", (name, value, constraint) => {
    expect(() => loadConfig({ [name]: value })).toThrow(
      `${name} must be ${constraint}`
    );
  });

  it.each([
    ["ALERT_THRESHOLD_PERCENT", "0", "greater than 0"],
    ["ALERT_THRESHOLD_PERCENT", "-0.5", "greater than 0"],
    ["ALERT_THRESHOLD_PERCENT", "NaN", "greater than 0"],
    ["ALERT_THRESHOLD_PERCENT", "Infinity", "greater than 0"],
    ["ALERT_THRESHOLD_PERCENT", "invalid", "greater than 0"],
    ["ALERT_WINDOW_MS", "0", "greater than 0"],
    ["ALERT_WINDOW_MS", "-1", "greater than 0"],
    ["ALERT_WINDOW_MS", "NaN", "greater than 0"],
    ["ALERT_WINDOW_MS", "Infinity", "greater than 0"],
    ["ALERT_BASELINE_TOLERANCE_MS", "-1", "greater than or equal to 0"],
    ["ALERT_BASELINE_TOLERANCE_MS", "NaN", "greater than or equal to 0"],
    ["ALERT_BASELINE_TOLERANCE_MS", "Infinity", "greater than or equal to 0"],
    ["ALERT_COOLDOWN_MS", "-1", "greater than or equal to 0"],
    ["ALERT_COOLDOWN_MS", "NaN", "greater than or equal to 0"],
    ["ALERT_COOLDOWN_MS", "Infinity", "greater than or equal to 0"],
  ])("rejects invalid numeric setting %s=%s", (name, value, constraint) => {
    expect(() => loadConfig({ [name]: value })).toThrow(
      `${name} must be a finite number ${constraint}`
    );
  });

  it.each(numericVariables)(
    "rejects an explicitly empty %s instead of using its default",
    (name) => {
      expect(() => loadConfig({ [name]: "" })).toThrow(`${name} must be`);
    }
  );

  it("rejects whitespace-only numerical settings", () => {
    expect(() => loadConfig({ ALERT_COOLDOWN_MS: "   " })).toThrow(
      "ALERT_COOLDOWN_MS must be"
    );
  });
});
