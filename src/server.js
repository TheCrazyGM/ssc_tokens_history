require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodeCleanup = require('node-cleanup');
const db = require('./db');
const config = require('../config');

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

    const dbQuery = db('transactions')
      .select('*')
      .orderBy('timestamp', 'desc')
      .orderBy('txid', 'asc')
      .offset(sOffset)
      .limit(sLimit);

    if (symbol) {
      dbQuery.where('symbol', symbol);
      dbQuery.andWhere(function () {
        this.where({ from: account, from_type: sType })
          .orWhere({ to: account, to_type: sType });
      });
    } else {
      dbQuery.where(function () {
        this.where({ from: account, from_type: sType })
          .orWhere({ to: account, to_type: sType });
      });
    }

    const rows = await dbQuery;
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
  db.destroy();
});
