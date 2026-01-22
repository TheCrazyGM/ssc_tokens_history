const db = require('../src/db');

async function initDB() {
  try {
    // Drop table if exists
    const exists = await db.schema.hasTable('transactions');
    if (exists) {
      console.log('Dropping existing transactions table...');
      await db.schema.dropTable('transactions');
    }

    console.log('Creating transactions table...');
    await db.schema.createTable('transactions', (table) => {
      table.bigInteger('block');
      table.string('txid').primary();
      table.timestamp('timestamp').notNullable(); // Knex handles DB specifics for timestamp
      table.string('symbol').notNullable();
      table.string('from').notNullable();
      table.string('from_type').notNullable();
      table.string('to').notNullable();
      table.string('to_type').notNullable();
      table.string('memo');
      table.decimal('quantity', 24, 8); // Adjusted precision/scale as generic numeric might default poorly
      
      // Index
      table.index('timestamp', 'idx_transactions_timestamp');
    });

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    db.destroy();
  }
}

initDB();
