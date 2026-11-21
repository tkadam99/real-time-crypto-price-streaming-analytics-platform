const {
  createEnvelope,
  serializeEnvelope,
} = require("../v2/eventContract");
const {
  DEFAULT_TIMEOUT_MS,
  consumerArguments,
  createDockerCliExecutor,
  main,
  parseConsumerOutput,
  parseOffsetSnapshot,
  runDiagnostic,
} = require("../scripts/v2DuplicateDeliveryDiagnostic");

function offsetOutput(offsets) {
  return Object.entries(offsets)
    .map(([partition, offset]) => `crypto-prices-v2:${partition}:${offset}`)
    .join("\n");
}

function snapshot(startByPartition, endByPartition) {
  return [
    { stdout: offsetOutput(startByPartition), exitCode: 0 },
    { stdout: offsetOutput(endByPartition), exitCode: 0 },
  ];
}

function value(symbol, sourceOffset, sourcePartition = 0) {
  return serializeEnvelope(createEnvelope({
    symbol,
    price: 100,
    timestamp: "2026-01-01T00:00:00.000Z",
  }, {
    clusterId: "source-cluster",
    topicGenerationId: "topic-generation",
    topic: "crypto-prices",
    partition: sourcePartition,
    offset: sourceOffset,
  }));
}

function formatted(partition, offset, envelope) {
  return `Partition:${partition}\tOffset:${offset}\t${envelope}`;
}

describe("V2 duplicate-delivery diagnostic", () => {
  test("captures fixed nonzero bounds before scanning and counts exact source identities", async () => {
    const calls = [];
    const outputs = snapshot(
      { 0: "100", 1: "500", 2: "0", 3: "0", 4: "0", 5: "0" },
      { 0: "103", 1: "501", 2: "0", 3: "0", 4: "0", 5: "0" },
    );
    const duplicate = value("BTC-USD", "9007199254740993");
    const distinct = value("BTC-USD", "9007199254740994");
    outputs.push(
      { stdout: [
        formatted(0, "100", duplicate),
        formatted(0, "101", duplicate),
        formatted(0, "102", distinct),
      ].join("\n"), exitCode: 0 },
      { stdout: formatted(1, "500", value("ETH-USD", "7", 0)), exitCode: 0 },
    );
    const executeCommand = jest.fn(async (args, options) => {
      calls.push({ args, options });
      return outputs.shift();
    });

    const report = await runDiagnostic({ executeCommand, maxRecords: 10 });

    expect(report.complete).toBe(true);
    expect(report.bounds[0]).toEqual({
      partition: 0,
      startOffset: "100",
      endOffsetExclusive: "103",
    });
    expect(report.bySymbol["BTC-USD"]).toEqual({
      totalRecords: 3,
      uniqueIdentities: 2,
      identitiesOccurringMoreThanOnce: 1,
      extraDuplicateDeliveries: 1,
    });
    expect(report.bySymbol["ETH-USD"]).toEqual({
      totalRecords: 1,
      uniqueIdentities: 1,
      identitiesOccurringMoreThanOnce: 0,
      extraDuplicateDeliveries: 0,
    });
    expect(report.scannedRecords).toBe(4);
    expect(report.malformedEnvelopes).toBe(0);
    expect(report.crossSymbolIdentityConflicts).toBe(0);
    expect(calls.slice(0, 2).map(({ args }) => args.slice(-2))).toEqual([
      ["--time", "-2"],
      ["--time", "-1"],
    ]);
    expect(calls[2].args).toEqual(expect.arrayContaining([
      "--partition", "0", "--offset", "100", "--max-messages", "3",
    ]));
    expect(calls[2].args).not.toContain("--group");
    expect(calls[2].args).toContain("enable.auto.commit=false");
    expect(calls[2].options).toEqual({ timeoutMs: DEFAULT_TIMEOUT_MS });
  });

  test("reports malformed envelopes, cross-symbol identities and out-of-bound records separately", async () => {
    const outputs = snapshot(
      { 0: "4", 1: "0", 2: "8", 3: "0", 4: "0", 5: "0" },
      { 0: "6", 1: "1", 2: "9", 3: "0", 4: "0", 5: "0" },
    );
    const sharedIdentity = value("BTC-USD", "42");
    outputs.push(
      { stdout: [
        formatted(0, "4", sharedIdentity),
        formatted(0, "6", sharedIdentity),
      ].join("\n"), exitCode: 0 },
      { stdout: formatted(1, "0", value("ETH-USD", "42")), exitCode: 0 },
      { stdout: formatted(2, "8", "not-json"), exitCode: 0 },
    );
    const executeCommand = jest.fn(async () => outputs.shift());

    const report = await runDiagnostic({ executeCommand, maxRecords: 10 });

    expect(report.malformedEnvelopes).toBe(1);
    expect(report.crossSymbolIdentityConflicts).toBe(1);
    expect(report.offsetBoundDiscrepancies).toEqual([
      { partition: 0, reason: "record-outside-or-out-of-order" },
      { partition: 0, reason: "offset-gap", count: "1" },
    ]);
    expect(report.incompleteReads).toEqual([
      { partition: 0, reason: "record-count-differs-from-offset-span" },
    ]);
    expect(report.complete).toBe(false);
  });

  test("does not scan if the offset span exceeds the configured maximum", async () => {
    const outputs = snapshot(
      { 0: "10", 1: "0", 2: "0", 3: "0", 4: "0", 5: "0" },
      { 0: "13", 1: "0", 2: "0", 3: "0", 4: "0", 5: "0" },
    );
    const executeCommand = jest.fn(async () => outputs.shift());

    const report = await runDiagnostic({ executeCommand, maxRecords: 2 });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(report.incompleteReads).toEqual([
      { partition: null, reason: "maximum-record-count-exceeded" },
    ]);
    expect(report.scannedRecords).toBe(0);
  });

  test("reports failed partition reads without exposing subprocess errors", async () => {
    const outputs = snapshot(
      { 0: "0", 1: "0", 2: "0", 3: "0", 4: "0", 5: "0" },
      { 0: "1", 1: "0", 2: "0", 3: "0", 4: "0", 5: "0" },
    );
    const executeCommand = jest.fn()
      .mockImplementationOnce(async () => outputs.shift())
      .mockImplementationOnce(async () => outputs.shift())
      .mockRejectedValueOnce(new Error("password=secret; private output"));

    const report = await runDiagnostic({ executeCommand, maxRecords: 2 });

    expect(report.incompleteReads).toEqual([
      { partition: 0, reason: "partition-read-failed" },
    ]);
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(report.complete).toBe(false);
  });

  test("validates complete six-partition offset snapshots and record lines", () => {
    expect(() => parseOffsetSnapshot("crypto-prices-v2:0:1")).toThrow();
    expect(parseConsumerOutput("Partition:2\tOffset:3\t{}", 2)).toEqual({
      records: [{ partition: 2, offset: 3n, value: "{}" }],
      malformedLines: [],
    });
    expect(parseConsumerOutput("unexpected output", 2).malformedLines).toHaveLength(1);
  });

  test("uses fixed Docker CLI execution without a shell and requires explicit opt-in", async () => {
    const execFileImpl = jest.fn((_command, _args, _options, callback) => {
      callback(null, "stdout", "");
    });
    const executeCommand = createDockerCliExecutor(execFileImpl);
    await executeCommand(consumerArguments(0, "0", 1, 1000), { timeoutMs: 1000 });

    expect(execFileImpl).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["exec", "-T", "v2-kafka"]),
      expect.objectContaining({ shell: false, timeout: 1000 }),
      expect.any(Function),
    );

    const injectedExecutor = jest.fn();
    await expect(main([], { executeCommand: injectedExecutor }))
      .rejects.toThrow("Explicit --execute opt-in is required.");
    expect(injectedExecutor).not.toHaveBeenCalled();
  });
});
