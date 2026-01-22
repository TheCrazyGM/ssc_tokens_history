# Hive-Engine Smart Contracts tokens history

Scans the Hive-Engine Smart Contracts blockchain (`src/history_builder.js`) to generate an index of historical
transactions (generally transfers) that can easily be queried using GET queries to the
NodeJS server `src/server.js`.

**Now supports PostgreSQL, MySQL, and SQLite!**

Used by [Hive-Engine](https://hive-engine.com) for transaction history (endpoint: `https://history.hive-engine.com/accountHistory`)

Created by @harpagon210 [(Original Github Repo)](https://github.com/harpagon210/ssc_tokens_history)

Some additional contributions by @someguy123 / @privex [(Privex Fork)](https://github.com/Privex/ssc_tokens_history)

Recent additions by @TheCrazyGM [(TheCrazyGM Fork)](https://github.com/TheCrazyGM/ssc_tokens_history)

Official Hive-Engine repository: [https://github.com/hive-engine/ssc_tokens_history](https://github.com/hive-engine/ssc_tokens_history)

Released under the **MIT License** (See the file `LICENSE` for more info)

## API Usage + Libraries

By default, the application itself exposes a single endpoint on port 3000 `/history`

The official history API for <https://history.hive-engine.com> is aliased to `/accountHistory`:

```bash
https://history.hive-engine.com/accountHistory
```

An example GET query to view the most recent 5 transactions made by @someguy123 using the token `SGTK`:

```bash
curl -fsSL https://history.hive-engine.com/accountHistory?account=someguy123&limit=5&offset=0&type=user&symbol=SGTK
```

**GET Parameters:**

- `account` - (required) Filter TXs to/from the username of a Steem account whom uses the SSC sidechain
- `limit` - (optional) The amount of recent TXs to load (Default: `500`)
- `offset` - (optional) For paginating, list transactions AFTER `offset` recent transactions (Default: `0`)
- `type` - (optional) Either `user` (TXs triggered by the user) or `contract` (TXs triggered by a smart contract)
- `symbol` - (optional) Only list transactions involving this token symbol, e.g. `ENG` or `STEEMP`

## Pre-requisites

- **NodeJS** 10 or higher
- **Database**: PostgreSQL, MySQL, or SQLite

## Installation

```bash
git clone https://github.com/hive-engine/ssc_tokens_history.git
cd ssc_tokens_history
npm install
```

## Configuration

Create a file called `.env` in the root directory and add your database connection string.

**PostgreSQL:**

```bash
DATABASE_URL=postgres://user:password@localhost:5432/dbname
```

**MySQL:**

```bash
DATABASE_URL=mysql://user:password@localhost:3306/dbname
```

**SQLite:**

```bash
# Option 1: File path prefixed with sqlite://
DATABASE_URL=sqlite://./history.sqlite

# Option 2: Explicit env vars
DB_CLIENT=sqlite3
DATABASE_URL='{"filename": "./history.sqlite"}'
```

Next, check `config.json` to ensure the RPC nodes are correct (default is testnet).

## Running + Final setup

1. **Initialize the Database**:

   ```bash
   npm run init-db
   ```

2. **Start the Indexer (History Builder)**:
   This scans blocks and populates the database. Run this in the background (e.g., using `pm2` or `screen`).

   ```bash
   npm run history
   ```

3. **Start the API Server**:

   ```bash
   npm start
   ```

## Directory Structure

- `src/`: Application source code (`server.js`, `history_builder.js`, `db.js`)
- `scripts/`: Utility scripts (`initDB.js`, `clearDB.js`)
- `docs/`: Documentation and notes

## Documentation

See the `docs/` folder for details on recent updates:

- [Dependency Updates](docs/dependency_update_notes.md)
- [Code Improvements](docs/code_improvement_notes.md)
- [Database Modernization](docs/database_modernization_notes.md)
