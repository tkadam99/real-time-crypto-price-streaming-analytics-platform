// Imports the official MongoDB driver
const { MongoClient } = require("mongodb");
const config = require("./config");

// create a singleton (one shared connection)
let db; let client;

const connectDB = async () => {
    if (db) {
        return db;
    }

    try {
        //  Creates a client pointed at mongodb://localhost:27017
        client = new MongoClient(config.mongoUri);

        // Opens the connection
        await client.connect();

        //  Selects the crypto_analytics database
        db = client.db(config.dbName);

        console.log(`Connected to MongoDB: ${config.dbName}`);

        return db;
    }
    catch (err) {
        console.error("Failed to Connect to MongoDB: ", err.message);
        process.exit(1);
    }
}

// Any file that needs the database calls getDB() instead of managing the connection themselves
const getDB = () => {
    if (!db) {
        throw new Error("Database not connected. Call connectDB() first");
    }
    return db;
}

const closeDB = async () => {
    if (client) {
        await client.close();
        db = null;
        console.log("MongoDB connected closed");
    }
}

module.exports = { connectDB, getDB, closeDB };