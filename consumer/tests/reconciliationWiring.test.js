const mockWorker = {
  start: jest.fn(),
  schedule: jest.fn(),
  stopScheduling: jest.fn(),
  drain: jest.fn().mockResolvedValue(),
};
const mockConsumer = {
  events: { COMMIT_OFFSETS: "commit", GROUP_JOIN: "join" },
  on: jest.fn(),
};
const mockAdmin = {};
const mockCollection = {};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({
    consumer: jest.fn(() => mockConsumer),
    admin: jest.fn(() => mockAdmin),
  })),
}));
jest.mock("../src/mongoClient", () => ({
  getDB: jest.fn(() => ({ collection: jest.fn(() => mockCollection) })),
}));
jest.mock("../src/commitReconciliation", () => ({
  createCommitReconciliation: jest.fn(() => mockWorker),
}));

describe("reconciliation consumer wiring", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("signals synchronously and unregisters listeners before draining", async () => {
    const removeCommit = jest.fn();
    const removeJoin = jest.fn();
    mockConsumer.on.mockReturnValueOnce(removeCommit).mockReturnValueOnce(removeJoin);
    const consumer = require("../src/kafkaConsumer");
    consumer.startReconciliation();
    expect(mockWorker.start).toHaveBeenCalledTimes(1);
    expect(() => consumer.startReconciliation()).toThrow("already initialized");
    const commit = mockConsumer.on.mock.calls[0][1];
    const join = mockConsumer.on.mock.calls[1][1];
    expect(commit()).toBeUndefined();
    expect(join()).toBeUndefined();
    expect(mockWorker.schedule.mock.calls).toEqual([["commit"], ["group-join"]]);
    consumer.beginConsumerShutdown();
    expect(mockWorker.stopScheduling).toHaveBeenCalledTimes(1);
    expect(removeCommit).toHaveBeenCalledTimes(1);
    expect(removeJoin).toHaveBeenCalledTimes(1);
    await consumer.drainReconciliation();
    expect(mockWorker.drain).toHaveBeenCalledTimes(1);
  });

  it("retains the first listener for shutdown if registering the second fails", async () => {
    const removeCommit = jest.fn();
    mockConsumer.on.mockReturnValueOnce(removeCommit).mockImplementationOnce(() => {
      throw new Error("listener registration failed");
    });
    const consumer = require("../src/kafkaConsumer");
    expect(() => consumer.startReconciliation()).toThrow("listener registration failed");
    consumer.beginConsumerShutdown();
    await consumer.drainReconciliation();
    expect(removeCommit).toHaveBeenCalledTimes(1);
    expect(mockWorker.drain).toHaveBeenCalledTimes(1);
  });

  it("passes the configured cleanup flag to the tracked worker", async () => {
    mockConsumer.on.mockReturnValue(jest.fn());
    const config = require("../src/config");
    const original = config.decisionCleanupEnabled;
    config.decisionCleanupEnabled = true;
    try {
      const consumer = require("../src/kafkaConsumer");
      consumer.startReconciliation();
      expect(require("../src/commitReconciliation").createCommitReconciliation)
        .toHaveBeenCalledWith(expect.objectContaining({ cleanupEnabled: true }));
      consumer.beginConsumerShutdown();
      await consumer.drainReconciliation();
    } finally {
      config.decisionCleanupEnabled = original;
    }
  });
});
