// Load .env file into process.env so we can read the env variables in our application
require("dotenv").config();

// Making the vaariables available to any other file by just importing
module.exports = {
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "crypto_analytics",
};