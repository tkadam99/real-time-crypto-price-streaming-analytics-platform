const { MongoClient } = require("mongodb");
const config = require("./config");

let db;
let client;

const connectDB = async () => {
  if (db) return db;

  try {
    client = new MongoClient(config.mongoUri);

    await client.connect();

    db = client.db(config.dbName);

    console.log(`Consumer connected to MongoDB: ${config.dbName}`);

    return db;
  } catch (err) {
    console.error("Consumer failed to connect to MongoDB:", err.message);
    process.exit(1);
  }
};

const getDB = () => {
  if (!db) {
    throw new Error("Database not connected. Call connectDB() first.");
  }
  return db;
};

module.exports = { connectDB, getDB };