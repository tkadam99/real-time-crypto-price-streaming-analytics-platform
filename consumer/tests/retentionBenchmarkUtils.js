const { createHash } = require("node:crypto");

function orderFor(seed, trial, step, names) {
  return [...names].sort((a, b) => {
    const rank = (name) => createHash("sha256").update(JSON.stringify([seed, trial, step, name])).digest("hex");
    const left = rank(a);
    const right = rank(b);
    return left < right ? -1 : left > right ? 1 : a.localeCompare(b);
  });
}

function extractPlan(explain) {
  const plans = [];
  function findPlanners(node) {
    if (!node || typeof node !== "object") return;
    if (node.queryPlanner && node.queryPlanner.winningPlan) plans.push(node.queryPlanner.winningPlan);
    for (const [key, value] of Object.entries(node)) {
      if (key !== "queryPlanner" && key !== "executionStats" && key !== "rejectedPlans") findPlanners(value);
    }
  }
  findPlanners(explain);
  const scans = [];
  const stages = new Set();
  function structure(node) {
    if (!node || typeof node !== "object") return null;
    const children = {};
    for (const key of Object.keys(node).sort()) {
      if (key === "rejectedPlans" || key === "slotBasedPlan") continue;
      const child = structure(node[key]);
      if (child) children[key] = child;
    }
    if (typeof node.stage === "string") {
      const result = { stage: node.stage };
      if (node.stage === "IXSCAN") {
        result.indexName = node.indexName ?? null;
        result.keyPattern = node.keyPattern ?? null;
        result.direction = node.direction ?? null;
      }
      if (Object.keys(children).length) result.children = children;
      return result;
    }
    return Object.keys(children).length ? children : null;
  }
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.stage === "string") {
      stages.add(node.stage);
      if (node.stage === "IXSCAN") {
        scans.push({ indexName: node.indexName ?? null, keyPattern: node.keyPattern ?? null, direction: node.direction ?? null });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "rejectedPlans" && key !== "slotBasedPlan") walk(value);
    }
  }
  for (const plan of plans) walk(plan);
  const known = new Set([
    "IXSCAN", "FETCH", "PROJECTION_COVERED", "PROJECTION_DEFAULT", "PROJECTION_SIMPLE",
    "SKIP", "LIMIT", "SORT", "SORT_SIMPLE", "SORT_MERGE", "SHARDING_FILTER",
    "SINGLE_SHARD", "SHARD_MERGE", "OR", "AND_SORTED", "AND_HASH", "EOF",
    "COLLSCAN", "IDHACK",
  ]);
  const unknown = [...stages].filter((stage) => !known.has(stage));
  const warnings = [];
  if (!plans.length) warnings.push("No winning plan was found in the explain output.");
  if (!stages.size) warnings.push("No interpretable classic query-plan stages were found.");
  if (!scans.length) warnings.push("No IXSCAN was found; index identity and direction cannot be established.");
  if (scans.some((scan) => !scan.indexName || !scan.keyPattern || !["forward", "backward"].includes(scan.direction))) warnings.push("An IXSCAN is missing index name, key pattern, or a recognized scan direction.");
  if (unknown.length) warnings.push(`Unrecognized stages: ${unknown.join(", ")}.`);
  const execution = {
    keysExamined: explain.executionStats?.totalKeysExamined ?? null,
    documentsExamined: explain.executionStats?.totalDocsExamined ?? null,
    returned: explain.executionStats?.nReturned ?? null,
  };
  if (Object.values(execution).some((value) => typeof value !== "number")) warnings.push("Execution statistics are missing or unsupported.");
  const blocking = stages.has("SORT") || stages.has("SORT_SIMPLE");
  return {
    interpreted: warnings.length === 0,
    blockingSort: blocking ? true : (plans.length && stages.size && !unknown.length ? false : null),
    indexScans: scans,
    stages: [...stages],
    structure: plans.map(structure),
    winningPlans: plans,
    warnings,
    execution,
  };
}

function comparePlans(reference, hinted) {
  const issues = [];
  if (!reference.interpreted || !hinted.interpreted) issues.push("At least one winning plan could not be fully interpreted.");
  if (reference.interpreted && hinted.interpreted) {
    if (JSON.stringify(reference.indexScans) !== JSON.stringify(hinted.indexScans)) issues.push("Winning index scans differ.");
    if (reference.blockingSort !== hinted.blockingSort) issues.push("Blocking SORT status differs.");
    if (JSON.stringify(reference.structure) !== JSON.stringify(hinted.structure)) issues.push("Winning plan stage structures differ.");
    if (JSON.stringify(reference.execution) !== JSON.stringify(hinted.execution)) issues.push("Selection execution counts differ.");
  }
  return { comparable: reference.interpreted && hinted.interpreted, match: issues.length === 0, issues };
}

module.exports = { orderFor, extractPlan, comparePlans };
