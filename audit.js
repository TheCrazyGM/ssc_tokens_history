/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const SSC = require('sscjs');
const fs = require('fs-extra');
const config = require('./config');
const { parseBlock, createCollections } = require('./history_builder');

const DEFAULT_REMOTE_NODE = 'https://api.hive-engine.com/rpc/';
const FETCH_RETRIES = 3;
const RETRY_BASE_MS = 500;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    last: null,
    rangeStart: null,
    rangeEnd: null,
    remoteNode: DEFAULT_REMOTE_NODE,
    repair: false,
    verbose: false,
    concurrency: 10,
  };

  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--last':
        opts.last = parseInt(args[i + 1], 10);
        i += 1;
        break;
      case '--range':
        opts.rangeStart = parseInt(args[i + 1], 10);
        opts.rangeEnd = parseInt(args[i + 2], 10);
        i += 2;
        break;
      case '--remote-node':
        opts.remoteNode = args[i + 1];
        i += 1;
        break;
      case '--repair':
        opts.repair = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--concurrency':
        opts.concurrency = parseInt(args[i + 1], 10);
        i += 1;
        break;
      case '--help':
        console.log('Usage: node audit.js [options]');
        console.log('');
        console.log('Options:');
        console.log('  --last <N>              Audit the last N blocks');
        console.log('  --range <start> <end>   Audit blocks from start to end (inclusive)');
        console.log('  --remote-node <url>     Remote RPC node (default: api.hive-engine.com/rpc/)');
        console.log('  --repair                Re-fetch missing blocks and re-parse them');
        console.log('  --verbose               Show per-block details');
        console.log('  --concurrency <N>       Parallel remote fetches (default: 10)');
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.last && opts.rangeStart === null) {
    opts.last = 1000;
    console.log('No range specified, defaulting to --last 1000');
  }

  return opts;
}

async function getBlockRange(chainColl, opts) {
  if (opts.rangeStart !== null && opts.rangeEnd !== null) {
    return { start: opts.rangeStart, end: opts.rangeEnd };
  }

  const maxBlock = await chainColl.findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } });
  if (!maxBlock) {
    throw new Error('No blocks found in hsc.chain');
  }

  const end = maxBlock._id;
  const start = Math.max(1, end - opts.last + 1);
  return { start, end };
}

async function findLocalGaps(chainColl, start, end) {
  const localBlocks = await chainColl.aggregate([
    { $match: { _id: { $gte: start, $lte: end } } },
    {
      $project: {
        _id: 1,
        txCount: { $size: { $ifNull: ['$transactions', []] } },
        vtxCount: { $size: { $ifNull: ['$virtualTransactions', []] } },
        hash: 1,
      },
    },
  ]).toArray();

  const localMap = new Map();
  for (const block of localBlocks) {
    localMap.set(block._id, {
      blockNumber: block._id,
      txCount: block.txCount,
      vtxCount: block.vtxCount,
      hash: block.hash,
    });
  }

  const missing = [];
  for (let i = start; i <= end; i += 1) {
    if (!localMap.has(i)) {
      missing.push(i);
    }
  }

  return { localMap, missing };
}

async function fetchRemoteBlock(ssc, blockNumber) {
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const block = await ssc.getBlockInfo(blockNumber);
      return block;
    } catch (err) {
      if (attempt < FETCH_RETRIES) {
        const delay = RETRY_BASE_MS * (2 ** (attempt - 1));
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        return { error: err.message || String(err) };
      }
    }
  }
  return null;
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function auditBlocks(start, end, localMap, remoteNode, concurrency, verbose) {
  const ssc = new SSC(remoteNode);
  const allBlockNumbers = [];
  for (let i = start; i <= end; i += 1) {
    allBlockNumbers.push(i);
  }

  const results = {
    ok: [],
    missing: [],
    mismatch: [],
    orphaned: [],
    errors: [],
  };

  const batches = chunk(allBlockNumbers, concurrency);
  let processed = 0;

  for (const batch of batches) {
    const remoteResults = await Promise.all(
      batch.map(async (blockNumber) => {
        const local = localMap.get(blockNumber);
        const remote = await fetchRemoteBlock(ssc, blockNumber);
        return { blockNumber, local, remote };
      }),
    );

    for (const { blockNumber, local, remote } of remoteResults) {
      processed += 1;

      if (processed % 500 === 0 || processed === allBlockNumbers.length) {
        process.stdout.write(`\rAudited ${processed}/${allBlockNumbers.length} blocks...`);
      }

      if (remote && remote.error) {
        results.errors.push({ blockNumber, error: remote.error });
        if (verbose) {
          console.log(`\n  ERROR #${blockNumber}: ${remote.error}`);
        }
        continue;
      }

      if (!local && !remote) {
        results.ok.push(blockNumber);
        continue;
      }

      if (!local && remote) {
        results.missing.push({
          blockNumber,
          remoteTxCount: (remote.transactions || []).length + (remote.virtualTransactions || []).length,
          remoteHash: remote.hash,
        });
        if (verbose) {
          console.log(`\n  MISSING #${blockNumber} (remote has ${(remote.transactions || []).length} txs)`);
        }
        continue;
      }

      if (local && !remote) {
        results.orphaned.push({
          blockNumber,
          localTxCount: local.txCount + local.vtxCount,
          localHash: local.hash,
        });
        if (verbose) {
          console.log(`\n  ORPHANED #${blockNumber} (local has ${local.txCount + local.vtxCount} txs)`);
        }
        continue;
      }

      if (local.hash !== remote.hash) {
        results.mismatch.push({
          blockNumber,
          localHash: local.hash,
          remoteHash: remote.hash,
          localTxCount: local.txCount + local.vtxCount,
          remoteTxCount: (remote.transactions || []).length + (remote.virtualTransactions || []).length,
        });
        if (verbose) {
          console.log(`\n  MISMATCH #${blockNumber} local=${local.hash} remote=${remote.hash}`);
        }
      } else {
        results.ok.push(blockNumber);
      }
    }
  }

  process.stdout.write('\n');
  return results;
}

async function repairBlocks(blockNumbers, remoteNode, chainColl, accountsHistory, nftHistory, marketHistory) {
  const ssc = new SSC(remoteNode);
  const repaired = [];
  const failed = [];

  for (let i = 0; i < blockNumbers.length; i += 1) {
    const blockNumber = blockNumbers[i];
    process.stdout.write(`\rRepairing block ${i + 1}/${blockNumbers.length}: #${blockNumber}`);

    const block = await fetchRemoteBlock(ssc, blockNumber);

    if (!block || block.error) {
      failed.push({ blockNumber, error: block ? block.error : 'null response' });
      continue;
    }

    try {
      await chainColl.updateOne(
        { _id: blockNumber },
        { $set: block },
        { upsert: true },
      );
      await parseBlock(block, accountsHistory, nftHistory, marketHistory);
      repaired.push(blockNumber);
    } catch (err) {
      failed.push({ blockNumber, error: err.message || String(err) });
    }
  }

  process.stdout.write('\n');
  return { repaired, failed };
}

function printReport(results, range, opts, repairResult) {
  const total = results.ok.length + results.missing.length + results.mismatch.length + results.orphaned.length + results.errors.length;

  console.log('');
  console.log('=== Block Audit Report ===');
  console.log(`Range: ${range.start.toLocaleString()} — ${range.end.toLocaleString()} (${total.toLocaleString()} blocks)`);
  console.log(`Remote: ${opts.remoteNode}`);
  console.log('');
  console.log(`  OK:       ${results.ok.length.toLocaleString()} blocks`);
  console.log(`  Missing:  ${results.missing.length.toLocaleString()} blocks  (present on remote, absent locally)`);
  console.log(`  Mismatch: ${results.mismatch.length.toLocaleString()} blocks  (hash differs)`);
  console.log(`  Orphaned: ${results.orphaned.length.toLocaleString()} blocks  (present locally, absent on remote)`);
  console.log(`  Errors:   ${results.errors.length.toLocaleString()} blocks  (failed to fetch from remote)`);

  if (results.missing.length > 0) {
    const nums = results.missing.map(b => b.blockNumber);
    console.log('');
    console.log(`  Missing blocks: ${nums.slice(0, 50).join(', ')}${nums.length > 50 ? ` ... (+${nums.length - 50} more)` : ''}`);
  }

  if (results.mismatch.length > 0) {
    const nums = results.mismatch.map(b => b.blockNumber);
    console.log('');
    console.log(`  Mismatch blocks: ${nums.slice(0, 50).join(', ')}${nums.length > 50 ? ` ... (+${nums.length - 50} more)` : ''}`);
  }

  if (repairResult) {
    console.log('');
    console.log(`  Repaired: ${repairResult.repaired.length} blocks`);
    if (repairResult.failed.length > 0) {
      console.log(`  Repair failed: ${repairResult.failed.length} blocks`);
    }
  }

  console.log('');
}

async function writeReportJson(results, range, opts, repairResult) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `audit_report_${timestamp}.json`;

  const report = {
    timestamp: new Date().toISOString(),
    range,
    remoteNode: opts.remoteNode,
    summary: {
      total: results.ok.length + results.missing.length + results.mismatch.length + results.orphaned.length + results.errors.length,
      ok: results.ok.length,
      missing: results.missing.length,
      mismatch: results.mismatch.length,
      orphaned: results.orphaned.length,
      errors: results.errors.length,
    },
    missing: results.missing,
    mismatch: results.mismatch,
    orphaned: results.orphaned,
    errors: results.errors,
  };

  if (repairResult) {
    report.repair = {
      repaired: repairResult.repaired,
      failed: repairResult.failed,
    };
  }

  await fs.writeJSON(filename, report, { spaces: 2 });
  console.log(`Report written to ${filename}`);
}

async function main() {
  const opts = parseArgs();

  console.log(`Connecting to MongoDB at ${process.env.DATABASE_URL}...`);
  const client = await MongoClient.connect(process.env.DATABASE_URL);

  const databaseNameHsc = config.databaseNameHsc || 'hsc';
  const databaseNameHistory = process.env.DATABASE_NAME || 'hsc_history';

  const dbHsc = client.db(databaseNameHsc);
  const dbHistory = client.db(databaseNameHistory);
  const chainColl = dbHsc.collection('chain');

  const accountsHistory = dbHistory.collection('accountsHistory');
  const nftHistory = dbHistory.collection('nftHistory');
  const marketHistory = dbHistory.collection('marketHistory');

  console.log(`Determining block range...`);
  const range = await getBlockRange(chainColl, opts);
  console.log(`Auditing blocks ${range.start.toLocaleString()} — ${range.end.toLocaleString()} (${(range.end - range.start + 1).toLocaleString()} blocks)`);

  console.log(`Finding local gaps in hsc.chain...`);
  const { localMap, missing } = await findLocalGaps(chainColl, range.start, range.end);
  console.log(`Found ${localMap.size.toLocaleString()} local blocks, ${missing.length.toLocaleString()} missing from chain collection`);

  console.log(`Fetching from remote node: ${opts.remoteNode}`);
  const results = await auditBlocks(range.start, range.end, localMap, opts.remoteNode, opts.concurrency, opts.verbose);

  let repairResult = null;
  if (opts.repair) {
    const blocksToRepair = [
      ...results.missing.map(b => b.blockNumber),
      ...results.mismatch.map(b => b.blockNumber),
    ];

    if (blocksToRepair.length > 0) {
      console.log(`\nRepairing ${blocksToRepair.length} blocks...`);
      await createCollections(dbHistory);
      repairResult = await repairBlocks(blocksToRepair, opts.remoteNode, chainColl, accountsHistory, nftHistory, marketHistory);
    } else {
      console.log('\nNo blocks to repair.');
    }
  }

  printReport(results, range, opts, repairResult);
  await writeReportJson(results, range, opts, repairResult);

  await client.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
