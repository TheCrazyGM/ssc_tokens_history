/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
require("dotenv").config();
const { MongoClient } = require("mongodb");
const SSC = require("sscjs");
const fs = require("fs-extra");
const { parseBlock, createCollections } = require("./history_builder");

const DEFAULT_REMOTE_NODE = "https://enginerpc.com";
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
      case "--last":
        opts.last = parseInt(args[i + 1], 10);
        i += 1;
        break;
      case "--range":
        opts.rangeStart = parseInt(args[i + 1], 10);
        opts.rangeEnd = parseInt(args[i + 2], 10);
        i += 2;
        break;
      case "--remote-node":
        opts.remoteNode = args[i + 1];
        i += 1;
        break;
      case "--repair":
        opts.repair = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--concurrency":
        opts.concurrency = parseInt(args[i + 1], 10);
        i += 1;
        break;
      case "--help":
        console.log("Usage: node audit.js [options]");
        console.log("");
        console.log("Options:");
        console.log("  --last <N>              Audit the last N blocks");
        console.log("  --range <start> <end>   Audit blocks from start to end (inclusive)");
        console.log(
          "  --remote-node <url>     Remote RPC node (default: api.hive-engine.com/rpc/)",
        );
        console.log("  --repair                Re-fetch missing blocks and re-parse them");
        console.log("  --verbose               Show per-block details");
        console.log("  --concurrency <N>       Parallel remote fetches (default: 10)");
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.last && opts.rangeStart === null) {
    opts.last = 1000;
    console.log("No range specified, defaulting to --last 1000");
  }

  return opts;
}

async function getBlockRange(accountsHistory, opts) {
  if (opts.rangeStart !== null && opts.rangeEnd !== null) {
    return { start: opts.rangeStart, end: opts.rangeEnd };
  }

  const maxParsed = await accountsHistory.findOne(
    {},
    { sort: { blockNumber: -1 }, projection: { blockNumber: 1 } },
  );
  if (!maxParsed) {
    throw new Error("No parsed blocks found in accountsHistory. Run the parser first.");
  }

  const end = maxParsed.blockNumber;
  const start = Math.max(1, end - opts.last + 1);
  return { start, end };
}

async function findParsedBlocks(accountsHistory, start, end) {
  const parsed = await accountsHistory
    .aggregate([
      { $match: { blockNumber: { $gte: start, $lte: end } } },
      { $group: { _id: "$blockNumber", txCount: { $sum: 1 } } },
    ])
    .toArray();

  const parsedMap = new Map();
  for (const doc of parsed) {
    parsedMap.set(doc._id, doc.txCount);
  }
  return parsedMap;
}

async function fetchRemoteBlock(ssc, blockNumber) {
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const block = await ssc.getBlockInfo(blockNumber);
      return block;
    } catch (err) {
      if (attempt < FETCH_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
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

function createMockCollection() {
  const docs = [];
  return {
    docs,
    insertOne: async (doc) => {
      docs.push(JSON.parse(JSON.stringify(doc)));
    },
    insertMany: async (arr) => {
      arr.forEach((doc) => docs.push(JSON.parse(JSON.stringify(doc))));
    },
    updateOne: async () => {},
    findOne: async () => null,
  };
}

async function auditBlocks(
  start,
  end,
  remoteNode,
  concurrency,
  verbose,
  accountsHistory,
  nftHistory,
  marketHistory,
) {
  const ssc = new SSC(remoteNode);
  const allBlockNumbers = [];
  for (let i = start; i <= end; i += 1) {
    allBlockNumbers.push(i);
  }

  const results = {
    ok: [],
    missing: [],
    partial: [],
    errors: [],
  };

  const batches = chunk(allBlockNumbers, concurrency);
  let processed = 0;

  for (const batch of batches) {
    const remoteResults = await Promise.all(
      batch.map(async (blockNumber) => {
        const remote = await fetchRemoteBlock(ssc, blockNumber);
        return { blockNumber, remote };
      }),
    );

    for (const { blockNumber, remote } of remoteResults) {
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

      if (!remote) {
        results.errors.push({ blockNumber, error: "null response" });
        continue;
      }

      // Simulate parsing the remote block to find expected history documents
      const mockAccounts = createMockCollection();
      const mockNft = createMockCollection();
      const mockMarket = createMockCollection();

      try {
        await parseBlock(remote, mockAccounts, mockNft, mockMarket);
      } catch (err) {
        results.errors.push({
          blockNumber,
          error: `Simulate parse failed: ${err.message || String(err)}`,
        });
        if (verbose) {
          console.log(`\n  ERROR #${blockNumber}: Simulate parse failed: ${err.message}`);
        }
        continue;
      }

      // Fetch actual history documents for this block from the database
      const actualAccounts = await accountsHistory.find({ blockNumber }).toArray();
      const actualNft = await nftHistory.find({ blockNumber }).toArray();

      const missingTxs = [];
      const extraTxs = [];

      // Compare expected accountsHistory docs to actual docs
      for (const expected of mockAccounts.docs) {
        const matchIndex = actualAccounts.findIndex(
          (actual) =>
            actual.transactionId === expected.transactionId &&
            actual.operation === expected.operation &&
            actual.account === expected.account &&
            String(actual.symbol || "") === String(expected.symbol || "") &&
            String(actual.quantity || "") === String(expected.quantity || ""),
        );
        if (matchIndex >= 0) {
          actualAccounts.splice(matchIndex, 1);
        } else {
          missingTxs.push(expected);
        }
      }

      // Check remaining actualAccounts as extra/duplicates
      if (actualAccounts.length > 0) {
        extraTxs.push(...actualAccounts);
      }

      // Compare expected nftHistory docs to actual docs
      for (const expected of mockNft.docs) {
        const matchIndex = actualNft.findIndex(
          (actual) =>
            actual.nftId === expected.nftId &&
            actual.symbol === expected.symbol &&
            actual.account === expected.account &&
            actual.accountHistoryId === expected.accountHistoryId,
        );
        if (matchIndex >= 0) {
          actualNft.splice(matchIndex, 1);
        } else {
          missingTxs.push({ nft: true, ...expected });
        }
      }

      // Check remaining actualNft as extra/duplicates
      if (actualNft.length > 0) {
        extraTxs.push(...actualNft);
      }

      const expectedCount = mockAccounts.docs.length + mockNft.docs.length;

      if (expectedCount === 0) {
        if (extraTxs.length > 0) {
          results.partial.push({
            blockNumber,
            expectedCount,
            missingCount: 0,
            extraCount: extraTxs.length,
            missing: [],
            extra: extraTxs,
          });
          if (verbose) {
            console.log(
              `\n  OVERPARSED/DUPLICATES #${blockNumber} (expected: 0, extra: ${extraTxs.length})`,
            );
          }
        } else {
          results.ok.push(blockNumber);
        }
        continue;
      }

      if (missingTxs.length > 0) {
        if (actualAccounts.length === 0 && actualNft.length === 0 && extraTxs.length === 0) {
          results.missing.push({
            blockNumber,
            expectedCount,
            missingCount: missingTxs.length,
            missing: missingTxs,
          });
          if (verbose) {
            console.log(
              `\n  MISSING #${blockNumber} (expected ${expectedCount} docs, 0 found locally)`,
            );
          }
        } else {
          results.partial.push({
            blockNumber,
            expectedCount,
            missingCount: missingTxs.length,
            extraCount: extraTxs.length,
            missing: missingTxs,
            extra: extraTxs,
          });
          if (verbose) {
            console.log(
              `\n  PARTIAL #${blockNumber} (expected: ${expectedCount}, missing: ${missingTxs.length}, extra: ${extraTxs.length})`,
            );
          }
        }
        continue;
      }

      if (extraTxs.length > 0) {
        results.partial.push({
          blockNumber,
          expectedCount,
          missingCount: 0,
          extraCount: extraTxs.length,
          missing: [],
          extra: extraTxs,
        });
        if (verbose) {
          console.log(`\n  DUPLICATED #${blockNumber} (extra docs: ${extraTxs.length})`);
        }
        continue;
      }

      results.ok.push(blockNumber);
    }
  }

  process.stdout.write("\n");
  return results;
}

async function repairBlocks(
  blockNumbers,
  remoteNode,
  chainColl,
  accountsHistory,
  nftHistory,
  marketHistory,
) {
  const ssc = new SSC(remoteNode);
  const repaired = [];
  const failed = [];

  for (let i = 0; i < blockNumbers.length; i += 1) {
    const blockNumber = blockNumbers[i];
    process.stdout.write(`\rRepairing block ${i + 1}/${blockNumbers.length}: #${blockNumber}`);

    const block = await fetchRemoteBlock(ssc, blockNumber);

    if (!block || block.error) {
      failed.push({ blockNumber, error: block ? block.error : "null response" });
      continue;
    }

    try {
      await chainColl.updateOne({ _id: blockNumber }, { $set: block }, { upsert: true });

      // Clean out existing records first to avoid creating duplicates!
      await accountsHistory.deleteMany({ blockNumber });
      await nftHistory.deleteMany({ blockNumber });

      await parseBlock(block, accountsHistory, nftHistory, marketHistory);
      repaired.push(blockNumber);
    } catch (err) {
      failed.push({ blockNumber, error: err.message || String(err) });
    }
  }

  process.stdout.write("\n");
  return { repaired, failed };
}

function printReport(results, range, opts, repairResult) {
  const total =
    results.ok.length + results.missing.length + results.partial.length + results.errors.length;

  console.log("");
  console.log("=== Block Audit Report ===");
  console.log(
    `Range: ${range.start.toLocaleString()} — ${range.end.toLocaleString()} (${total.toLocaleString()} blocks)`,
  );
  console.log(`Remote: ${opts.remoteNode}`);
  console.log("");
  console.log(`  OK:       ${results.ok.length.toLocaleString()} blocks`);
  console.log(
    `  Missing:  ${results.missing.length.toLocaleString()} blocks  (expected txs missing locally)`,
  );
  console.log(
    `  Partial/Duplicated:  ${results.partial.length.toLocaleString()} blocks  (expected vs actual mismatch or duplicates)`,
  );
  console.log(
    `  Errors:   ${results.errors.length.toLocaleString()} blocks  (failed to fetch/parse block)`,
  );

  if (results.missing.length > 0) {
    const nums = results.missing.map((b) => b.blockNumber);
    console.log("");
    console.log(
      `  Missing blocks: ${nums.slice(0, 50).join(", ")}${nums.length > 50 ? ` ... (+${nums.length - 50} more)` : ""}`,
    );
  }

  if (results.partial.length > 0) {
    const nums = results.partial.map((b) => b.blockNumber);
    console.log("");
    console.log(
      `  Partial/Duplicated blocks: ${nums.slice(0, 50).join(", ")}${nums.length > 50 ? ` ... (+${nums.length - 50} more)` : ""}`,
    );
  }

  if (repairResult) {
    console.log("");
    console.log(`  Repaired: ${repairResult.repaired.length} blocks`);
    if (repairResult.failed.length > 0) {
      console.log(`  Repair failed: ${repairResult.failed.length} blocks`);
    }
  }

  console.log("");
}

async function writeReportJson(results, range, opts, repairResult) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `audit_report_${timestamp}.json`;

  const report = {
    timestamp: new Date().toISOString(),
    range,
    remoteNode: opts.remoteNode,
    summary: {
      total:
        results.ok.length + results.missing.length + results.partial.length + results.errors.length,
      ok: results.ok.length,
      missing: results.missing.length,
      partial: results.partial.length,
      errors: results.errors.length,
    },
    missing: results.missing,
    partial: results.partial,
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

  const databaseNameHistory = process.env.DATABASE_NAME || "hsc_history";
  const dbHistory = client.db(databaseNameHistory);
  const chainColl = dbHistory.collection("chain");

  const accountsHistory = dbHistory.collection("accountsHistory");
  const nftHistory = dbHistory.collection("nftHistory");
  const marketHistory = dbHistory.collection("marketHistory");

  console.log("Ensuring indexes...");
  await accountsHistory.createIndex({ blockNumber: 1 });

  console.log("Determining block range...");
  const range = await getBlockRange(accountsHistory, opts);
  console.log(
    `Auditing blocks ${range.start.toLocaleString()} — ${range.end.toLocaleString()} (${(range.end - range.start + 1).toLocaleString()} blocks)`,
  );

  console.log(`Fetching from remote node: ${opts.remoteNode}`);
  const results = await auditBlocks(
    range.start,
    range.end,
    opts.remoteNode,
    opts.concurrency,
    opts.verbose,
    accountsHistory,
    nftHistory,
    marketHistory,
  );

  let repairResult = null;
  if (opts.repair) {
    const blocksToRepair = [
      ...results.missing.map((b) => b.blockNumber),
      ...results.partial.filter((b) => b.missingCount > 0).map((b) => b.blockNumber),
    ];

    if (blocksToRepair.length > 0) {
      console.log(`\nRepairing ${blocksToRepair.length} blocks...`);
      await createCollections(dbHistory);
      repairResult = await repairBlocks(
        blocksToRepair,
        opts.remoteNode,
        chainColl,
        accountsHistory,
        nftHistory,
        marketHistory,
      );
    } else {
      console.log("\nNo blocks to repair.");
    }
  }

  printReport(results, range, opts, repairResult);
  await writeReportJson(results, range, opts, repairResult);

  await client.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
