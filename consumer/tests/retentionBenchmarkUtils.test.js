const { extractPlan, comparePlans, orderFor } = require("./retentionBenchmarkUtils");
const { event, snapshotSummary, validateRetention } = require("./retentionHarness");

const ixscan = {
  stage: "IXSCAN", indexName: "retention", keyPattern: { symbol: 1, timestamp: 1, receivedAt: 1, _id: 1 }, direction: "backward",
};
const explain = (queryPlan) => ({
  queryPlanner: { winningPlan: { queryPlan, slotBasedPlan: { stages: "opaque" } }, rejectedPlans: [{ stage: "SORT" }] },
  executionStats: { totalKeysExamined: 10001, totalDocsExamined: 0, nReturned: 1 },
});

test("extracts nested SBE winning plan without reading rejected plans", () => {
  const plan = extractPlan(explain({ stage: "PROJECTION_COVERED", inputStage: { stage: "SKIP", inputStage: ixscan } }));
  expect(plan.interpreted).toBe(true);
  expect(plan.blockingSort).toBe(false);
  expect(plan.indexScans).toEqual([{ indexName: "retention", keyPattern: ixscan.keyPattern, direction: "backward" }]);
  expect(plan.execution).toEqual({ keysExamined: 10001, documentsExamined: 0, returned: 1 });
});

test("detects blocking sort and reports plan differences", () => {
  const normal = extractPlan(explain(ixscan));
  const sorted = extractPlan(explain({ stage: "SORT", inputStage: ixscan }));
  expect(sorted.blockingSort).toBe(true);
  expect(comparePlans(normal, sorted)).toEqual(expect.objectContaining({ comparable: true, match: false }));
  const first = extractPlan(explain({ stage: "SKIP", inputStage: { stage: "FETCH", inputStage: ixscan } }));
  const second = extractPlan(explain({ stage: "FETCH", inputStage: { stage: "SKIP", inputStage: ixscan } }));
  expect(comparePlans(first, second).issues).toContain("Winning plan stage structures differ.");
});

test("marks missing and unrecognized structures as uninterpretable", () => {
  const missing = extractPlan({ queryPlanner: { winningPlan: { slotBasedPlan: {} } } });
  expect(missing.interpreted).toBe(false);
  expect(missing.blockingSort).toBeNull();
  expect(missing.warnings.length).toBeGreaterThan(0);
  const unknown = extractPlan(explain({ stage: "FUTURE_STAGE", inputStage: ixscan }));
  expect(unknown.interpreted).toBe(false);
  expect(unknown.blockingSort).toBeNull();
  expect(comparePlans(missing, unknown).match).toBe(false);
  const noStats = extractPlan({ queryPlanner: { winningPlan: ixscan } });
  expect(noStats.warnings).toContain("Execution statistics are missing or unsupported.");
});

test("extracts shard winning plans rather than rejected plans", () => {
  const plan = extractPlan({ shards: {
    one: { queryPlanner: { winningPlan: ixscan } },
    two: { queryPlanner: { winningPlan: ixscan } },
  }, executionStats: { totalKeysExamined: 20, totalDocsExamined: 0, nReturned: 2 } });
  expect(plan.indexScans).toHaveLength(2);
  expect(plan.interpreted).toBe(true);
});

test("execution order is deterministic for the same seed and varies over steps", () => {
  const names = ["reference", "hinted", "boundary"];
  const orders = Array.from({ length: 30 }, (_, step) => orderFor("seed", 0, step, names));
  expect(orders).toEqual(Array.from({ length: 30 }, (_, step) => orderFor("seed", 0, step, names)));
  expect(new Set(orders.map((order) => order.join(","))).size).toBeGreaterThan(1);
  for (const order of orders) expect([...order].sort()).toEqual([...names].sort());
});

test("independent oracle rejects common errors, excess and unrelated changes", () => {
  const btc = [event("BTC-USD", 3), event("BTC-USD", 2), event("BTC-USD", 1)];
  const eth = event("ETH-USD", 1);
  const before = [...btc, eth];
  const expected = [...btc.slice(0, 2), eth];
  expect(() => validateRetention(before, expected, "BTC-USD", 2)).not.toThrow();
  expect(() => validateRetention(before, before, "BTC-USD", 2)).toThrow("strict cap exceeded");
  expect(() => validateRetention(before, [btc[0], btc[2], eth], "BTC-USD", 2, "hinted"))
    .toThrow("hinted: retained identities/order/content differ");
  expect(() => validateRetention(before, [btc[1], btc[0], eth], "BTC-USD", 2)).toThrow("retained identities/order/content differ");
  expect(() => validateRetention(before, btc.slice(0, 2), "BTC-USD", 2)).toThrow("unrelated symbols changed");
  expect(snapshotSummary(expected).collectionCount).toBe(3);
  expect(snapshotSummary(expected).symbols["BTC-USD"].count).toBe(2);
  expect(snapshotSummary(expected).symbols["ETH-USD"].count).toBe(1);
});
