const mockSend = jest.fn();

jest.mock("kafkajs", () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: () => ({
      connect: jest.fn(),
      send: mockSend,
    }),
  })),
}));

const config = require("../src/config");
const { sendMessage } = require("../src/kafkaProducer");

describe("sendMessage", () => {
  beforeEach(() => {
    mockSend.mockReset();
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
});
