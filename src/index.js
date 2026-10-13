import { config } from "./config.js";
import { openDatabase } from "./db/database.js";
import { seedProducts } from "./db/seed.js";
import { createApp } from "./app.js";

const db = openDatabase(config.databaseFile);
if (db.prepare("SELECT COUNT(*) n FROM products").get().n === 0) {
  console.log(`Empty catalogue, seeded ${seedProducts(db)} products.`);
}

const { app, services } = createApp({ db, config });

// Release stock held by card orders that were never paid.
const sweep = setInterval(() => {
  const n = services.orders.expireUnpaid(config.unpaidOrderTtlMinutes);
  if (n) console.log(`Cancelled ${n} unpaid order(s) and released their stock.`);
}, 5 * 60_000);
sweep.unref();

const server = app.listen(config.port, () => {
  console.log(`Soulinspire API on http://localhost:${config.port} (payments: ${services.payments.mode})`);
  if (!config.adminApiKey) console.log("Admin API is off. Set ADMIN_API_KEY to turn it on.");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
