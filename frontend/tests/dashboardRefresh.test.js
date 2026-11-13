import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createDashboardRefresh, DASHBOARD_REFRESH_INTERVAL_MS } from "../src/services/dashboardRefresh.js";
import { fetchCurrentPrices } from "../src/services/api.js";
import { currentPriceCards, formatMarketTimestamp } from "../src/utils/currentPriceCards.js";
import { marketFreshness } from "../src/utils/marketFreshness.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const calls = [];
  const states = [];
  let currentTime = Date.parse("2026-01-01T00:00:00Z");
  let tick;
  let cancelled;
  let interval;
  function request(kind, symbol, signal) {
    const pending = deferred();
    calls.push({ kind, symbol, signal, ...pending });
    return pending.promise;
  }
  const worker = createDashboardRefresh({
    fetchCurrentPrices: (signal) => request("current", null, signal),
    fetchMetrics: (signal) => request("metrics", null, signal),
    fetchAlerts: (_limit, signal) => request("alerts", null, signal),
    fetchPriceHistory: (symbol, _limit, signal) => request("history", symbol, signal),
    onChange: (state) => states.push(state),
    now: () => currentTime,
    schedule: (callback, delay) => { tick = callback; interval = delay; return 123; },
    cancel: (id) => { cancelled = id; },
  });
  function resolve(call, data) {
    call.resolve({ success: true, data });
  }
  function resolveBatch(start, marker = 1) {
    resolve(calls[start], [{ symbol: "BTC-USD", price: marker, marketTimestamp: "2025-12-31T23:59:00Z" }]);
    resolve(calls[start + 1], [{ symbol: "BTC-USD", latestPrice: marker }]);
    resolve(calls[start + 2], [{ message: `alert-${marker}` }]);
    resolve(calls[start + 3], [{ price: marker }]);
  }
  return {
    worker, calls, states, resolve, resolveBatch,
    tick: () => tick(),
    setTime: (value) => { currentTime = value; },
    interval: () => interval,
    cancelled: () => cancelled,
    latest: () => states.at(-1),
  };
}
const flush = () => setImmediate();

test("current-price API helper uses the endpoint, parses JSON, and surfaces HTTP failure", async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  let received;
  globalThis.fetch = async (...args) => {
    received = args;
    return { ok: true, json: async () => ({ success: true, data: [{ symbol: "BTC-USD", price: 42 }] }) };
  };
  try {
    assert.deepEqual(await fetchCurrentPrices(signal), { success: true, data: [{ symbol: "BTC-USD", price: 42 }] });
    assert.equal(received[0], "http://localhost:5000/api/prices/current");
    assert.deepEqual(received[1], { cache: "no-store", signal });
    globalThis.fetch = async () => ({ ok: false });
    await assert.rejects(fetchCurrentPrices(signal), /Failed to fetch current prices/);
  } finally {
    globalThis.fetch = original;
  }
});

test("initial request, ten-second polling and manual refresh preserve historical data", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  assert.equal(h.interval(), DASHBOARD_REFRESH_INTERVAL_MS);
  assert.equal(h.interval(), 10000);
  assert.deepEqual(h.calls.map((call) => call.kind), ["current", "metrics", "alerts", "history"]);
  assert.equal(h.calls[3].symbol, "BTC-USD");
  h.resolveBatch(0);
  await flush();
  assert.equal(h.latest().currentPrices[0].price, 1);
  assert.equal(h.latest().metrics[0].latestPrice, 1);
  assert.equal(h.latest().alerts[0].message, "alert-1");
  assert.equal(h.latest().history[0].price, 1);
  h.tick();
  await flush();
  assert.equal(h.calls.length, 8);
  assert.equal(h.latest().currentPrices[0].price, 1);
  h.resolveBatch(4, 2);
  await flush();
  h.worker.refresh();
  await flush();
  h.resolveBatch(8, 3);
  await flush();
  assert.equal(h.latest().currentPrices[0].price, 3);
  assert.equal(h.latest().metrics[0].latestPrice, 3);
  h.worker.stop();
});

test("each lane succeeds independently of failure in the other", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.resolveBatch(0);
  await flush();
  h.tick();
  await flush();
  h.calls[4].reject(new Error("current unavailable"));
  h.resolve(h.calls[5], [{ latestPrice: 2 }]);
  h.resolve(h.calls[6], [{ message: "new alert" }]);
  h.resolve(h.calls[7], [{ price: 2 }]);
  await flush();
  assert.equal(h.latest().currentError, "current unavailable");
  assert.equal(h.latest().currentPrices[0].price, 1);
  assert.equal(h.latest().metrics[0].latestPrice, 2);
  h.tick();
  await flush();
  h.resolve(h.calls[8], [{ symbol: "BTC-USD", price: 3, marketTimestamp: "2025-12-31T23:59:00Z" }]);
  h.calls[9].reject(new Error("metrics unavailable"));
  h.resolve(h.calls[10], []);
  h.resolve(h.calls[11], []);
  await flush();
  assert.equal(h.latest().currentPrices[0].price, 3);
  assert.equal(h.latest().metrics[0].latestPrice, 2);
  assert.equal(h.latest().alerts[0].message, "new alert");
  assert.equal(h.latest().historyError, "metrics unavailable");
  assert.equal(h.latest().currentError, "");
  h.worker.stop();
});

test("one stalled lane does not block the other lane or prevent freshness aging", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.resolveBatch(0);
  await flush();
  const time = h.latest().currentTime;
  h.tick();
  await flush();
  h.resolve(h.calls[4], [{ symbol: "BTC-USD", price: 2, marketTimestamp: "2025-12-31T23:59:00Z" }]);
  await flush();
  h.setTime(time + 70000);
  h.tick();
  await flush();
  assert.equal(h.calls.length, 9);
  assert.equal(h.calls[8].kind, "current");
  assert.equal(marketFreshness(h.latest().currentPrices[0].marketTimestamp, h.latest().currentTime), "stale");
  h.worker.stop();
  h.resolve(h.calls[5], []);
  h.resolve(h.calls[6], []);
  h.resolve(h.calls[7], []);
  h.resolve(h.calls[8], []);
  await flush();
});

test("a current-price result becomes visible before a stalled historical request settles", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.resolve(h.calls[0], [{ symbol: "BTC-USD", price: 42, marketTimestamp: "2026-01-01T00:00:00Z" }]);
  await flush();
  assert.equal(h.latest().hasCurrentPrices, true);
  assert.equal(h.latest().currentPrices[0].price, 42);
  assert.equal(h.latest().hasHistory, false);
  h.worker.stop();
  h.resolve(h.calls[1], []);
  h.resolve(h.calls[2], []);
  h.resolve(h.calls[3], []);
  await flush();
});

test("queued manual requests do not overlap or publish superseded results", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.worker.refresh();
  h.worker.refresh();
  await flush();
  assert.equal(h.calls.length, 4);
  h.resolveBatch(0, 1);
  await flush();
  assert.equal(h.states.some((s) => s.currentPrices[0]?.price === 1), false);
  assert.equal(h.calls.length, 8);
  h.resolveBatch(4, 2);
  await flush();
  assert.equal(h.latest().currentPrices[0].price, 2);
  assert.equal(h.latest().metrics[0].latestPrice, 2);
  h.worker.stop();
});

test("symbol changes invalidate only historical requests and retain current prices", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.worker.setSymbol("ETH-USD");
  h.worker.setSymbol("SOL-USD");
  h.resolveBatch(0);
  await flush();
  assert.equal(h.latest().currentPrices[0].price, 1);
  assert.equal(h.latest().hasHistory, false);
  assert.equal(h.calls.length, 7);
  assert.equal(h.calls[6].symbol, "SOL-USD");
  h.resolve(h.calls[4], [{ latestPrice: 5 }]);
  h.resolve(h.calls[5], [{ message: "new" }]);
  h.resolve(h.calls[6], [{ price: 5 }]);
  await flush();
  assert.equal(h.latest().historySymbol, "SOL-USD");
  assert.equal(h.latest().history[0].price, 5);
  h.worker.stop();
});

test("empty and missing snapshots never fall back to historical metrics or percentage changes", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.resolve(h.calls[0], []);
  h.resolve(h.calls[1], [{ symbol: "BTC-USD", latestPrice: 10, percentChange: 5 }]);
  h.resolve(h.calls[2], []);
  h.resolve(h.calls[3], []);
  await flush();
  assert.equal(h.latest().hasCurrentPrices, true);
  assert.deepEqual(currentPriceCards(h.latest().currentPrices), [
    { symbol: "BTC-USD", price: null, marketTimestamp: null },
    { symbol: "ETH-USD", price: null, marketTimestamp: null },
    { symbol: "SOL-USD", price: null, marketTimestamp: null },
  ]);
  const cards = currentPriceCards([{ symbol: "ETH-USD", price: 22, marketTimestamp: "2026-01-01T00:00:00Z", percentChange: 99 }]);
  assert.equal(cards[0].price, null);
  assert.deepEqual(cards[1], { symbol: "ETH-USD", price: 22, marketTimestamp: "2026-01-01T00:00:00Z" });
  assert.equal(cards[2].price, null);
  assert.equal(formatMarketTimestamp(undefined), "Unknown");
  assert.equal(formatMarketTimestamp("bad"), "Unknown");
  h.worker.stop();
});

test("invalid response preserves previous valid data and later recovery clears the error", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.resolveBatch(0);
  await flush();
  h.tick();
  await flush();
  h.calls[4].resolve({ success: true, data: null });
  h.resolve(h.calls[5], []);
  h.resolve(h.calls[6], []);
  h.resolve(h.calls[7], []);
  await flush();
  assert.equal(h.latest().currentError, "Invalid dashboard API response");
  assert.equal(h.latest().currentPrices[0].price, 1);
  h.tick();
  await flush();
  h.resolveBatch(8, 2);
  await flush();
  assert.equal(h.latest().currentPrices[0].price, 2);
  assert.equal(h.latest().currentError, "");
  h.worker.stop();
});

test("unmount cancels the timer, aborts both lanes and ignores pending results", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  const stateCount = h.states.length;
  h.worker.stop();
  assert.equal(h.cancelled(), 123);
  assert.equal(h.calls.every((call) => call.signal.aborted), true);
  h.resolveBatch(0);
  await flush();
  assert.equal(h.states.length, stateCount);
});

test("freshness uses market event time and preserves submillisecond future skew", () => {
  const now = Date.parse("2026-01-01T00:02:00Z");
  const time = (age) => new Date(now - age).toISOString();
  assert.equal(marketFreshness(time(30000), now), "fresh");
  assert.equal(marketFreshness(time(30001), now), "delayed");
  assert.equal(marketFreshness(time(120000), now), "delayed");
  assert.equal(marketFreshness(time(120001), now), "stale");
  for (const value of [undefined, "", "bad", "2026-02-29T00:00:00Z", new Date(now + 1).toISOString(), "2026-01-01T00:02:00.000000001Z"]) {
    assert.equal(marketFreshness(value, now), "unknown");
  }
  assert.equal(marketFreshness("2026-01-01T00:01:29.999999999Z", now), "delayed");
});

test("last successful request time is separate from historical market time", async () => {
  const h = setup();
  h.worker.start();
  await flush();
  h.setTime(Date.parse("2026-01-01T00:03:00Z"));
  h.resolveBatch(0);
  await flush();
  assert.equal(h.latest().lastCurrentRefresh, Date.parse("2026-01-01T00:03:00Z"));
  assert.equal(marketFreshness(h.latest().currentPrices[0].marketTimestamp, h.latest().currentTime), "stale");
  h.worker.stop();
});
