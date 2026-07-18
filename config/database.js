const mongoose = require('mongoose');

// Falls back to a local instance when MONGO_URI is unset so a missing env var
// doesn't turn into a cryptic `connect(undefined)` crash.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/truevision';

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGO_URI, {
      // Fail fast instead of buffering commands for 30s when Mongo is down.
      serverSelectionTimeoutMS: 10000,
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB connection failed: ${error.message}`);
    // Fail-fast at boot: a server with no database is not useful.
    process.exit(1);
  }
};

// Post-boot resilience: log drops/reconnects instead of failing silently. A
// disconnect after startup would otherwise buffer commands until they time out
// with no operator signal.
mongoose.connection.on('error', (err) => {
  console.error(`⚠️  MongoDB error: ${err.message}`);
});
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected — driver will attempt to reconnect.');
});
mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected.');
});

module.exports = connectDB;
