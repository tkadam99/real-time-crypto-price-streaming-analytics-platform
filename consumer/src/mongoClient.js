const { MongoClient } = require("mongodb");
const config = require("./config");

let db;
let client;

const connectDB = async () => {
  if (db) return db;

  client = new MongoClient(config.mongoUri);

  await client.connect();

  db = client.db(config.dbName);

  console.log(`Consumer connected to MongoDB: ${config.dbName}`);

  return db;
};

const getDB = () => {
  if (!db) {
    throw new Error("Database not connected. Call connectDB() first.");
  }
  return db;
};

const closeDB = async () => {
  if (client) {
    await client.close();
    db = undefined;
    client = undefined;
    console.log("Consumer MongoDB connection closed");
  }
};

module.exports = { connectDB, getDB, closeDB };