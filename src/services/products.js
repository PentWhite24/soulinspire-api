import { CATEGORIES } from "../db/catalog.js";

const SORT_SQL = {
  featured: "rank ASC",
  new: "(badge = 'New') DESC, rank ASC",
  low: "price ASC, rank ASC",
  high: "price DESC, rank ASC",
};

export function toProduct(row) {
  return {
    id: row.id,
    name: row.name,
    cat: row.category,
    price: row.price,
    line: row.line,
    desc: row.description,
    glyph: row.glyph,
    c1: row.c1,
    c2: row.c2,
    bg: row.bg,
    badge: row.badge,
    stock: row.stock,
    rank: row.rank,
    sizes: row.sizes ? JSON.parse(row.sizes) : undefined,
    facts: JSON.parse(row.facts),
    image: row.image || undefined,
    ...(row.active === 0 && { active: false }),
  };
}

export function createProductService(db) {
  const byIdStmt = db.prepare("SELECT * FROM products WHERE id = ?");

  return {
    categories: () => CATEGORIES,

    list({ q, category, sort = "featured", includeInactive = false } = {}) {
      const where = [];
      const params = {};
      if (!includeInactive) where.push("active = 1");
      if (category && category !== "all") { where.push("category = @category"); params.category = category; }
      if (q) {
        where.push("(name LIKE @q OR line LIKE @q OR description LIKE @q OR category LIKE @q)");
        params.q = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
      }
      const sql = `SELECT * FROM products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${SORT_SQL[sort]}`;
      return db.prepare(sql.replace(/LIKE @q/g, "LIKE @q ESCAPE '\\'")).all(params).map(toProduct);
    },

    get(id) {
      const row = byIdStmt.get(id);
      return row ? toProduct(row) : null;
    },

    update(id, patch) {
      const cols = { name: "name", price: "price", stock: "stock", badge: "badge", image: "image", description: "description", line: "line", active: "active" };
      const sets = [];
      const params = { id };
      for (const [k, v] of Object.entries(patch)) {
        sets.push(`${cols[k]} = @${k}`);
        params[k] = k === "active" ? (v ? 1 : 0) : v;
      }
      const info = db.prepare(`UPDATE products SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = @id`).run(params);
      return info.changes ? this.get(id) : null;
    },
  };
}
