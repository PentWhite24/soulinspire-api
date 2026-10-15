import { config } from "./config.js";
import { createPool, migrate } from "./db/database.js";
import { seedIfEmpty } from "./db/seed.js";
import { createApp } from "./app.js";

const db = createPool(config.db);

// Create the tables (first start only) and load the starter catalogue into an empty database.
await migrate(db, {
  afterMigrate: async (client) => {
    const n = await seedIfEmpty(client);
    if (n) console.log(`Empty catalogue, seeded ${n} products.`);
  },
});

const { app, services } = createApp({ db, config });

// Release stock held by card orders that were never paid.
const sweep = setInterval(async () => {
  try {
    const n = await services.orders.expireUnpaid(config.unpaidOrderTtlMinutes);
    if (n) console.log(`Cancelled ${n} unpaid order(s) and released their stock.`);
  } catch (err) {
    console.error("Unpaid-order sweep failed:", err.message);
  }
}, 5 * 60_000);
sweep.unref();

const server = app.listen(config.port, () => {
  console.log(`Soulinspire API on http://localhost:${config.port} (payments: ${services.payments.mode})`);
  if (!config.adminApiKey) console.log("Admin API is off. Set ADMIN_API_KEY to turn it on.");
});

// Finish in-flight requests, close database connections, then exit.
// PM2 sends SIGINT on stop/reload; Auto Scaling shutdowns send SIGTERM.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down.`);
    server.close(() => db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
