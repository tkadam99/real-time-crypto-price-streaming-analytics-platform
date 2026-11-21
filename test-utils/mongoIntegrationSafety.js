const { randomUUID } = require("node:crypto");

const DEFAULT_APPLICATION_DATABASE_NAME = "crypto_analytics";
const generatedDatabases = new WeakMap();

function getMongoIntegrationUri(env = process.env) {
  const uri = env.MONGO_INTEGRATION_URI;
  if (uri === undefined || uri === "") return null;

  if (
    typeof uri !== "string"
    || uri.trim() !== uri
    || /[\s\\\x00-\x1f\x7f]/.test(uri)
    || /%(?![0-9a-f]{2})/i.test(uri)
  ) {
    throw new Error("MONGO_INTEGRATION_URI must be a valid local MongoDB connection URI.");
  }
  if (env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS !== "true") {
    throw new Error(
      "MongoDB integration tests require ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true."
    );
  }

  const uriParts = /^mongodb:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(uri);
  if (!uriParts) {
    throw new Error("MONGO_INTEGRATION_URI must be a valid local MongoDB connection URI.");
  }

  const authority = uriParts[1];
  const atIndex = authority.lastIndexOf("@");
  const credentials = atIndex === -1 ? "" : authority.slice(0, atIndex);
  const host = authority.slice(atIndex + 1);
  if (
    (atIndex !== -1 && (!credentials.split(":")[0] || credentials.includes("@")))
    || (credentials.match(/:/g) || []).length > 1
  ) {
    throw new Error("MONGO_INTEGRATION_URI must be a valid local MongoDB connection URI.");
  }

  const hostParts = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  if (!hostParts) {
    if (/^(localhost|127\.0\.0\.1|\[::1\]):[^,]*$/i.test(host)) {
      throw new Error("MONGO_INTEGRATION_URI must have a valid MongoDB port.");
    }
    throw new Error(
      "MongoDB integration tests may connect only to localhost, 127.0.0.1, or ::1 using a single host."
    );
  }
  if (hostParts[2] && (Number(hostParts[2]) < 1 || Number(hostParts[2]) > 65535)) {
    throw new Error("MONGO_INTEGRATION_URI must have a valid MongoDB port.");
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("MONGO_INTEGRATION_URI must be a valid local MongoDB connection URI.");
  }

  if (
    parsed.protocol !== "mongodb:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error(
      "MongoDB integration tests may connect only to localhost, 127.0.0.1, or ::1."
    );
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error("MONGO_INTEGRATION_URI must be a valid local MongoDB connection URI.");
  }

  let configuredDatabaseName = "";
  if (uriParts[2] && uriParts[2] !== "/") {
    const encodedDatabaseName = uriParts[2].slice(1);
    if (!encodedDatabaseName || encodedDatabaseName.includes("/")) {
      throw new Error("MONGO_INTEGRATION_URI contains an invalid database name.");
    }

    try {
      configuredDatabaseName = decodeURIComponent(encodedDatabaseName);
    } catch {
      throw new Error("MONGO_INTEGRATION_URI contains an invalid database name.");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(configuredDatabaseName)) {
      throw new Error("MONGO_INTEGRATION_URI contains an invalid database name.");
    }
  }

  const applicationDatabaseName = env.DB_NAME || DEFAULT_APPLICATION_DATABASE_NAME;
  if (
    configuredDatabaseName
    && configuredDatabaseName.toLowerCase() === applicationDatabaseName.toLowerCase()
  ) {
    throw new Error(
      "MONGO_INTEGRATION_URI must not target the application's configured database."
    );
  }

  let directConnection = false;
  const options = new Set();
  if (uriParts[3] !== undefined) {
    if (!uriParts[2] || !uriParts[3]) {
      throw new Error("MONGO_INTEGRATION_URI contains invalid options.");
    }
    for (const option of uriParts[3].split("&")) {
      const match = /^([^=]+)=([^=]+)$/.exec(option);
      if (!match) throw new Error("MONGO_INTEGRATION_URI contains invalid options.");

      let key;
      let value;
      try {
        key = decodeURIComponent(match[1]).toLowerCase();
        value = decodeURIComponent(match[2]);
      } catch {
        throw new Error("MONGO_INTEGRATION_URI contains invalid options.");
      }
      if (options.has(key)) {
        throw new Error("MONGO_INTEGRATION_URI contains duplicate options.");
      }
      options.add(key);
      if (key === "directconnection" && value === "true") {
        directConnection = true;
      } else if (key === "authsource" && /^[a-zA-Z0-9_-]+$/.test(value)) {
        continue;
      } else if (key === "tls" && (value === "true" || value === "false")) {
        continue;
      } else {
        throw new Error("MONGO_INTEGRATION_URI contains an unsupported or unsafe option.");
      }
    }
  }

  if (directConnection) return uri;
  if (uriParts[3] !== undefined) return `${uri}&directConnection=true`;
  return `${uri}${uriParts[2] ? "?" : "/?"}directConnection=true`;
}

function isGeneratedTestDatabaseName(name) {
  return typeof name === "string"
    && /^[a-z][a-z0-9_]{0,29}_[0-9a-f]{32}$/.test(name);
}

function createMongoTestDatabase(client, prefix) {
  if (typeof prefix !== "string" || !/^[a-z][a-z0-9_]{0,29}$/.test(prefix)) {
    throw new Error("MongoDB integration test database prefix is invalid.");
  }
  if (!client || typeof client.db !== "function") {
    throw new Error("A connected MongoDB client is required for integration tests.");
  }

  const name = `${prefix}_${randomUUID().replace(/-/g, "")}`;
  if (!isGeneratedTestDatabaseName(name)) {
    throw new Error("Generated MongoDB integration test database name is invalid.");
  }

  const database = client.db(name);
  if (!database || database.databaseName !== name || typeof database.dropDatabase !== "function") {
    throw new Error("MongoDB client did not return the generated integration test database.");
  }
  generatedDatabases.set(database, name);
  return database;
}

function getMongoTestDatabaseName(database) {
  const generatedName = database && generatedDatabases.get(database);
  if (
    !generatedName
    || generatedName !== database.databaseName
    || !isGeneratedTestDatabaseName(generatedName)
  ) {
    throw new Error("MongoDB database was not generated for this test run.");
  }
  return generatedName;
}

async function dropMongoTestDatabase(database) {
  if (
    !database
    || generatedDatabases.get(database) !== database.databaseName
    || !isGeneratedTestDatabaseName(database.databaseName)
  ) {
    throw new Error("Refusing to drop a MongoDB database not generated for this test run.");
  }

  generatedDatabases.delete(database);
  return database.dropDatabase();
}

module.exports = {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoTestDatabaseName,
  getMongoIntegrationUri,
  isGeneratedTestDatabaseName,
};
