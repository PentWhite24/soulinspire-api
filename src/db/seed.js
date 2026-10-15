import { fileURLToPath } from "node:url";
import { PRODUCTS } from "./catalog.js";
import { createPool, migrate } from "./database.js";

const COLUMNS = ["id", "name", "category", "price", "line", "description", "glyph", "c1", "c2", "bg", "badge", "stock", "rank", "sizes", "facts", "image"];

// Inserts the starter catalogue. Existing products are left untouched unless
// `overwrite` is true, so stock and price changes made through the admin API survive restarts.
// `db` is a pool or a client: anything with .query().
export async function seedProducts(db, { overwrite = false } = {}) {
  const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  const onConflict = overwrite
    ? `ON CONFLICT (id) DO UPDATE SET ${COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = now()`
    : "ON CONFLICT (id) DO NOTHING";
  const sql = `INSERT INTO products (${COLUMNS.join(", ")}) VALUES (${placeholders}) ${onConflict}`;
  for (const p of PRODUCTS) {
    await db.query(sql, [
      p.id, p.name, p.cat, p.price, p.line, p.desc, p.glyph, p.c1, p.c2, p.bg, p.badge || "", p.stock, p.rank,
      p.sizes ? JSON.stringify(p.sizes) : null, JSON.stringify(p.facts || []), p.image || null,
    ]);
  }
  return PRODUCTS.length;
}

/** Seeds only when the catalogue is empty (first start against a new database). */
export async function seedIfEmpty(db) {
  const { rows } = await db.query("SELECT COUNT(*) AS n FROM products");
  if (rows[0].n > 0) return 0;
  return seedProducts(db);
}

// `npm run seed` resets the catalogue to the starter data.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config } = await import("../config.js");
  const pool = createPool(config.db);
  await migrate(pool);
  const n = await seedProducts(pool, { overwrite: true });
  console.log(`Seeded ${n} products into ${config.db.connectionString ? "DATABASE_URL" : `${config.db.host}/${config.db.database}`}`);
  await pool.end();
}
