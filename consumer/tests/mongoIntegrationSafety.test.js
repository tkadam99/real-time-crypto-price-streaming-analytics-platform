const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
  isGeneratedTestDatabaseName,
} = require("../../test-utils/mongoIntegrationSafety");

describe("MongoDB integration test safety", () => {
  const optedIn = {
    MONGO_INTEGRATION_URI: "mongodb://localhost:27017/test",
    ALLOW_DESTRUCTIVE_INTEGRATION_TESTS: "true",
  };

  test("keeps integration tests disabled when the URI is missing", () => {
    expect(getMongoIntegrationUri({
      ALLOW_DESTRUCTIVE_INTEGRATION_TESTS: "true",
    })).toBeNull();
  });

  test("requires explicit destructive-test opt-in", () => {
    expect(() => getMongoIntegrationUri({
      MONGO_INTEGRATION_URI: optedIn.MONGO_INTEGRATION_URI,
    })).toThrow("ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true");
  });

  test.each([
    ["mongodb://localhost:27017/test", "mongodb://localhost:27017/test?directConnection=true"],
    ["mongodb://127.0.0.1", "mongodb://127.0.0.1/?directConnection=true"],
    ["mongodb://[::1]:27017/?authSource=admin", "mongodb://[::1]:27017/?authSource=admin&directConnection=true"],
    ["mongodb://localhost/test?directConnection=true", "mongodb://localhost/test?directConnection=true"],
  ])("accepts an opted-in local URI and enforces a direct connection: %s", (uri, expected) => {
    expect(getMongoIntegrationUri({ ...optedIn, MONGO_INTEGRATION_URI: uri })).toBe(expected);
  });

  test("rejects remote MongoDB endpoints even with explicit opt-in", () => {
    expect(() => getMongoIntegrationUri({
      ...optedIn,
      MONGO_INTEGRATION_URI: "mongodb://db.example.com:27017/test",
    })).toThrow("only to localhost");
  });

  test("rejects malformed MongoDB URIs", () => {
    expect(() => getMongoIntegrationUri({
      ...optedIn,
      MONGO_INTEGRATION_URI: "mongodb://localhost:bad-port/test",
    })).toThrow("valid MongoDB port");
  });

  test.each([
    "mongodb://localhost:27017,127.0.0.1:27017/test",
    "mongodb://localhost,remote.example/test",
    "mongodb+srv://localhost/test",
    "mongodb://localhost:/test",
    "mongodb://localhost:0/test",
    "mongodb://localhost:65536/test",
    "mongodb://localhost:bad/test",
    "mongodb://:pass@localhost/test",
    "mongodb://localhost/test/../other",
    "mongodb://localhost/%2e%2e/test",
    "mongodb://localhost/test?authSource",
    "mongodb://localhost/test?authSource=%FF",
    "mongodb://localhost/test?directConnection=true&directConnection=true",
    "mongodb://localhost/test?directConnection=false",
    "mongodb://localhost/test?proxyHost=remote.example",
    "mongodb://localhost/test?loadBalanced=true",
    "mongodb://localhost/test?replicaSet=example",
    "mongodb://localhost/test#fragment",
  ])("rejects unsafe or malformed URI %s", (uri) => {
    expect(() => getMongoIntegrationUri({ ...optedIn, MONGO_INTEGRATION_URI: uri })).toThrow();
  });

  test("rejects the application's configured database", () => {
    expect(() => getMongoIntegrationUri({
      ...optedIn,
      MONGO_INTEGRATION_URI: "mongodb://localhost:27017/crypto_analytics",
    })).toThrow("application's configured database");
  });

  test("only generated test database names can be dropped", async () => {
    const database = {
      databaseName: "",
      dropDatabase: jest.fn().mockResolvedValue({ ok: 1 }),
    };
    const client = {
      db: jest.fn((name) => {
        database.databaseName = name;
        return database;
      }),
    };
    const testDatabase = createMongoTestDatabase(client, "unit_test");

    expect(isGeneratedTestDatabaseName(testDatabase.databaseName)).toBe(true);
    await dropMongoTestDatabase(testDatabase);
    expect(database.dropDatabase).toHaveBeenCalledTimes(1);

    const arbitraryDatabase = {
      databaseName: `unit_test_${"a".repeat(32)}`,
      dropDatabase: jest.fn(),
    };
    expect(isGeneratedTestDatabaseName(arbitraryDatabase.databaseName)).toBe(true);
    await expect(dropMongoTestDatabase(arbitraryDatabase)).rejects.toThrow("Refusing to drop");
    expect(arbitraryDatabase.dropDatabase).not.toHaveBeenCalled();
  });

  test("rejects a registered handle whose name changed to another generated name", async () => {
    const database = { dropDatabase: jest.fn() };
    const client = {
      db: jest.fn((name) => {
        database.databaseName = name;
        return database;
      }),
    };
    createMongoTestDatabase(client, "unit_test");
    database.databaseName = `unit_test_${"a".repeat(32)}`;
    expect(isGeneratedTestDatabaseName(database.databaseName)).toBe(true);

    await expect(dropMongoTestDatabase(database)).rejects.toThrow("Refusing to drop");
    expect(database.dropDatabase).not.toHaveBeenCalled();
  });

  test("rejects repeated cleanup after a successful drop", async () => {
    const database = { dropDatabase: jest.fn().mockResolvedValue({ ok: 1 }) };
    const client = { db: (name) => Object.assign(database, { databaseName: name }) };
    createMongoTestDatabase(client, "unit_test");

    await dropMongoTestDatabase(database);
    await expect(dropMongoTestDatabase(database)).rejects.toThrow("Refusing to drop");
    expect(database.dropDatabase).toHaveBeenCalledTimes(1);
  });

  test("propagates cleanup failures and does not permit another drop", async () => {
    const failure = new Error("drop failed");
    const database = { dropDatabase: jest.fn().mockRejectedValue(failure) };
    const client = { db: (name) => Object.assign(database, { databaseName: name }) };
    createMongoTestDatabase(client, "unit_test");

    await expect(dropMongoTestDatabase(database)).rejects.toBe(failure);
    await expect(dropMongoTestDatabase(database)).rejects.toThrow("Refusing to drop");
    expect(database.dropDatabase).toHaveBeenCalledTimes(1);
  });

  test.each(["", "UPPERCASE", "1starts_with_digit", "has-dash", "a".repeat(31), null])(
    "rejects invalid database prefix %s",
    (prefix) => {
      const client = { db: jest.fn() };
      expect(() => createMongoTestDatabase(client, prefix)).toThrow("prefix is invalid");
      expect(client.db).not.toHaveBeenCalled();
    }
  );
});
