require('dotenv').config();
const knex = require('knex');

const dbConfig = {
  client: 'pg', // Default to Postgres
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 10 },
  useNullAsDefault: true, // Required for SQLite
};

// Simple heuristic to detect DB type from URL or explicit env var
if (process.env.DB_CLIENT) {
  dbConfig.client = process.env.DB_CLIENT;
} else if (process.env.DATABASE_URL) {
  if (process.env.DATABASE_URL.startsWith('mysql')) {
    dbConfig.client = 'mysql2';
  } else if (process.env.DATABASE_URL.startsWith('sqlite')) {
    dbConfig.client = 'sqlite3';
    // Handle file path for SQLite
    if (process.env.DATABASE_URL.includes('://')) {
        dbConfig.connection = {
            filename: process.env.DATABASE_URL.split('://')[1]
        };
    }
  }
}

// Special handling for MySQL SSL if needed (example)
// if (dbConfig.client === 'mysql2' && process.env.DB_SSL === 'true') {
//   dbConfig.connection = {
//     ...parseConnectionString(process.env.DATABASE_URL),
//     ssl: { rejectUnauthorized: false }
//   };
// }

const db = knex(dbConfig);

module.exports = db;
