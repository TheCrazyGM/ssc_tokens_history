# Database Modernization Notes

## Overview
This document outlines the changes made to support multiple database backends (PostgreSQL, MySQL, SQLite) using Knex.js.

## Changes

### 1. Introduced Knex.js
- **Dependency**: Added `knex` as a query builder.
- **Drivers**: Added `mysql2` and `sqlite3` drivers alongside the existing `pg` driver.
- **Configuration**: Created `db.js` to initialize the database connection based on environment variables.

### 2. Configuration (`db.js`)
- **Logic**: 
    - Checks for `DB_CLIENT` env var (e.g., 'pg', 'mysql2', 'sqlite3').
    - If not found, attempts to infer the client from `DATABASE_URL` prefix (e.g., `mysql://...` -> `mysql2`).
    - Defaults to `pg` if neither is specified.
    - Handles SQLite file paths from connection strings.

### 3. Schema Initialization (`initDB.js`)
- **Refactor**: Replaced raw SQL `CREATE TABLE` with `knex.schema.createTable`.
- **Benefits**: 
    - Database agnostic schema creation.
    - Handles data types (like `timestamp`, `bigInteger`, `decimal`) appropriately for each DB.
    - Automatically manages index creation.

### 4. Data Insertion (`history_builder.js`)
- **Refactor**: Replaced `pool.query` `INSERT` statements with `knex('transactions').insert(...)`.
- **Benefits**:
    - Automatic parameter binding for all supported databases.
    - Simplified code structure.

### 5. API Queries (`server.js`)
- **Refactor**: Replaced raw SQL `SELECT` queries with Knex chainable methods.
- **Logic**:
    - `db('transactions').select('*').orderBy(...).limit(...).offset(...)`
    - Dynamic `where` clauses for filtering by symbol/account.
- **Benefits**:
    - Prevents SQL injection (standard Knex feature).
    - Consistent pagination behavior across DBs.

### 6. Utility Scripts
- **`clearDB.js`**: Updated to use `knex('transactions').truncate()` for a clean table reset.

## How to Run

### PostgreSQL (Default)
Set `DATABASE_URL` to your Postgres connection string.
```bash
DATABASE_URL=postgres://user:pass@localhost:5432/dbname npm start
```

### MySQL
Set `DATABASE_URL` to your MySQL connection string.
```bash
DATABASE_URL=mysql://user:pass@localhost:3306/dbname npm start
```

### SQLite
Set `DATABASE_URL` to a file path (prefixed with `sqlite://` or just use `DB_CLIENT`).
```bash
# Option 1
DATABASE_URL=sqlite://./mydb.sqlite npm start

# Option 2
DB_CLIENT=sqlite3 DATABASE_URL='{"filename": "./mydb.sqlite"}' npm start
```
