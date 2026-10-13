import { fileURLToPath } from "node:url";
import { PRODUCTS } from "./catalog.js";
import { openDatabase } from "./database.js";

// Inserts the starter catalogue. Existing products are left untouched unless
// `overwrite` is true, so stock and price changes made through the admin API survive restarts.
export function seedProducts(db, { overwrite = false } = {}) {
  const sql = `INSERT INTO products (id, name, category, price, line, description, glyph, c1, c2, bg, badge, stock, rank, sizes, facts, image)
    VALUES (@id, @name, @cat, @price, @line, @desc, @glyph, @c1, @c2, @bg, @badge, @stock, @rank, @sizes, @facts, @image)
    ${overwrite ? `ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, price=excluded.price, line=excluded.line,
      description=excluded.description, glyph=excluded.glyph, c1=excluded.c1, c2=excluded.c2, bg=excluded.bg, badge=excluded.badge,
      stock=excluded.stock, rank=excluded.rank, sizes=excluded.sizes, facts=excluded.facts, image=excluded.image, updated_at=datetime('now')`
      : "ON CONFLICT(id) DO NOTHING"}`;
  const insert = db.prepare(sql);
  const run = db.transaction(() => {
    for (const p of PRODUCTS) {
      insert.run({ ...p, sizes: p.sizes ? JSON.stringify(p.sizes) : null, facts: JSON.stringify(p.facts || []), image: p.image || null, badge: p.badge || "" });
    }
  });
  run();
  return PRODUCTS.length;
}

// `npm run seed` resets the catalogue to the starter data.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config } = await import("../config.js");
  const db = openDatabase(config.databaseFile);
  const n = seedProducts(db, { overwrite: true });
  console.log(`Seeded ${n} products into ${config.databaseFile}`);
  db.close();
}
