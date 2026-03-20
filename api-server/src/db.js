// Imports the official MongoDB driver
const { MongoClient } = require("mongodb");
const config = require("./config");

// create a singleton (one shared connection)
let db; let client;


