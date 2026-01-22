const db = require('./db');

async function clearDB() {
  try {
    console.log('Clearing transactions table...');
    // Truncate is cleaner than delete for full clear
    await db('transactions').truncate();
    console.log('Database cleared.');
  } catch (err) {
    console.error('Error clearing database:', err);
  } finally {
    db.destroy();
  }
}

clearDB();
