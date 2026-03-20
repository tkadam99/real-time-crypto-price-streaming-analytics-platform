require("dotenv").config();

module.exports = {
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "crypto_analytics",
};