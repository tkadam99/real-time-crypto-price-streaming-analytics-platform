const mockSend = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();

jest.mock("kafkajs", () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: () => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      send: mockSend,
    }),
  })),
}));

const config = require("../src/config");
const { sendMessage, connectProducer, disconnectProducer } = require("../src/kafkaProducer");

describe("sendMessage", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockConnect.mockReset();
    mockDisconnect.mockReset();
  });

  it("publishes the message to the configured topic", async () => {
    const event = {
      symbol: "BTC-USD",
      price: 68000,
      timestamp: "2026-04-04T12:00:00Z",
    };
    const brokerResponse = [{ topicName: config.kafkaTopic }];
    mockSend.mockResolvedValue(brokerResponse);

    await expect(sendMessage(event)).resolves.toBe(brokerResponse);
    expect(mockSend).toHaveBeenCalledWith({
      topic: config.kafkaTopic,
      messages: [{ value: JSON.stringify(event) }],
    });
  });

  it("propagates Kafka send failures to the caller", async () => {
    const error = new Error("Kafka unavailable");
    mockSend.mockRejectedValue(error);

    await expect(sendMessage({ symbol: "BTC-USD" })).rejects.toBe(error);
  });

  it("propagates connection failures for startup cleanup", async () => {
    const error = new Error("Kafka connect failed");
    mockConnect.mockRejectedValue(error);
    await expect(connectProducer()).rejects.toBe(error);
  });

  it("disconnects the shared Kafka producer and propagates errors", async () => {
    const error = new Error("Kafka disconnect failed");
    mockDisconnect.mockRejectedValue(error);
    await expect(disconnectProducer()).rejects.toBe(error);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
