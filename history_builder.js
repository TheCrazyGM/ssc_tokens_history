require('dotenv').config();
const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const SSC = require('sscjs');
const db = require('./db');
const { Queue } = require('./libs/Queue');
const config = require('./config');

const sscNodes = new Queue();
config.nodes.forEach(node => sscNodes.push(node));

const getSSCNode = () => {
  const node = sscNodes.pop();
  sscNodes.push(node);

  console.log('Using SSC node:', node); // eslint-disable-line no-console
  return node;
};

let ssc = new SSC(getSSCNode());

const TOKENS_CONTRACT_NAME = 'tokens';
const TRANSFER = 'transfer';
const TRANSFER_TO_CONTRACT = 'transferToContract';
const TRANSFER_FROM_CONTRACT = 'transferFromContract';

let { lastSSCBlockParsed } = config; // eslint-disable-line prefer-const

async function parseBlock(block) {
  const { transactions, timestamp, blockNumber } = block;

  console.log(`parsing block #${blockNumber}`); // eslint-disable-line no-console

  const nbTxs = transactions.length;
  // Knex will handle timestamp formatting for supported DBs usually,
  // but keeping basic date object or ISO string is safer.
  // Original code appended .000Z to timestamp which implies it came as ISO string without ms?
  // Let's assume timestamp is ISO string.
  const finalTimestamp = new Date(`${timestamp}.000Z`);

  for (let index = 0; index < nbTxs; index += 1) {
    const tx = transactions[index];

    const {
      transactionId,
      payload,
      logs,
    } = tx;

    let logsObj;
    try {
      logsObj = JSON.parse(logs);
    } catch (e) {
      // invalid logs, skip
      continue;
    }

    let payloadObj = null;

    if (logsObj) {
      const { events } = logsObj;

      if (events && events.length > 0) {
        let txToSave = false;
        let insertData = {};
        const nbEvents = events.length;

        for (let idx = 0; idx < nbEvents; idx += 1) {
          const ev = events[idx];
          const finalTxId = nbEvents > 1 ? `${transactionId}-${idx}` : transactionId;

          if (ev.contract === TOKENS_CONTRACT_NAME) {
            const {
              from,
              to,
              symbol,
              quantity,
            } = ev.data;

            if (ev.event === TRANSFER) {
              insertData = {
                block: blockNumber,
                txid: finalTxId,
                timestamp: finalTimestamp,
                symbol,
                from,
                from_type: 'user',
                to,
                to_type: 'user',
                quantity
              };
              txToSave = true;
            } else if (ev.event === TRANSFER_TO_CONTRACT) {
              insertData = {
                block: blockNumber,
                txid: finalTxId,
                timestamp: finalTimestamp,
                symbol,
                from,
                from_type: 'user',
                to,
                to_type: 'contract',
                quantity
              };
              txToSave = true;
            } else if (ev.event === TRANSFER_FROM_CONTRACT) {
              insertData = {
                block: blockNumber,
                txid: finalTxId,
                timestamp: finalTimestamp,
                symbol,
                from,
                from_type: 'contract',
                to,
                to_type: 'user',
                quantity
              };
              txToSave = true;
            }

            if (txToSave) {
              // check if there is a memo in the transfer
              if (payloadObj === null) {
                try {
                  payloadObj = JSON.parse(payload);
                } catch (e) {
                  // invalid payload
                }
              }

              const memo = payloadObj ? payloadObj.memo : null;

              if (memo && typeof memo === 'string') {
                insertData.memo = memo;
              }

              // add the transaction to the history
              await db('transactions').insert(insertData); // eslint-disable-line no-await-in-loop
            }
          }
        }
      }
    }
  }

  lastSSCBlockParsed = block.blockNumber;
}

async function parseSSCChain(blockNumber) {
  try {
    const block = await ssc.getBlockInfo(blockNumber);
    let newBlockNumber = blockNumber;

    if (block !== null) {
      newBlockNumber += 1;
      await parseBlock(block);

      setTimeout(() => parseSSCChain(newBlockNumber), config.pollingTime);
    } else {
      setTimeout(() => parseSSCChain(newBlockNumber), config.pollingTime);
    }
  } catch (error) {
    console.log(error);
    ssc = new SSC(getSSCNode());
    setTimeout(() => parseSSCChain(blockNumber), config.pollingTime);
  }
}

parseSSCChain(lastSSCBlockParsed);

// graceful app closing
nodeCleanup((exitCode, signal) => { // eslint-disable-line no-unused-vars
  console.log('start saving conf'); // eslint-disable-line no-console
  const conf = fs.readJSONSync('./config.json');
  conf.lastSSCBlockParsed = lastSSCBlockParsed + 1;
  fs.writeJSONSync('./config.json', conf, { spaces: 4 });
  db.destroy();
  console.log('done saving conf'); // eslint-disable-line no-console
});
