require('dotenv').config();
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodeCleanup = require('node-cleanup');
const config = require('./config');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const app = express();
app.use(cors({ methods: ['GET'] }));
app.use(bodyParser.json({ type: 'application/json' }));

const historyRouter = express.Router();

historyRouter.get('/', async (req, res) => {
  try {
    const { query } = req;
    const {
      account,
      offset,
      limit,
      type,
      symbol,
    } = query;

    const sOffset = Math.max(0, parseInt(offset, 10) || 0);
    const sLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 500));

    const sType = type !== 'user' && type !== 'contract' ? 'user' : type;

    if (symbol) {
      const SQLQuery = `
      SELECT *
      FROM "transactions"
      WHERE 
        (
          ("from" = $1 AND "from_type" = $2) OR
          ("to" = $1 AND "to_type" = $2)
        ) AND
        "symbol" = $3
      ORDER BY "timestamp" DESC, "txid" ASC
      OFFSET $4
      LIMIT $5`;

      const { rows } = await pool.query(SQLQuery, [account, sType, symbol, sOffset, sLimit]);
      return res.status(200).json(rows);
    }

    const SQLQuery = `
      SELECT *
      FROM "transactions"
      WHERE 
        ("from" = $1 AND "from_type" = $2) OR
        ("to" = $1 AND "to_type" = $2)
      ORDER BY "timestamp" DESC, "txid" ASC
      OFFSET $3
      LIMIT $4`;

    const { rows } = await pool.query(SQLQuery, [account, sType, sOffset, sLimit]);
    return res.status(200).json(rows);
  } catch (err) {
    console.error(err); // eslint-disable-line no-console
    return res.status(400).json({
      errors: ['an error occured'],
    });
  }
});

app.use('/history', historyRouter);

app.set('trust proxy', true);

app.listen(config.port);

// graceful app closing
nodeCleanup((exitCode, signal) => { // eslint-disable-line no-unused-vars
  pool.end();
});
