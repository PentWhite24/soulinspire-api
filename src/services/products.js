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
  return {
    categories: () => CATEGORIES,

    async list({ q, category, sort = "featured", includeInactive = false } = {}) {
      const where = [];
      const params = [];
      if (!includeInactive) where.push("active = 1");
      if (category && category !== "all") {
        params.push(category);
        where.push(`category = $${params.length}`);
      }
      if (q) {
        // Case-insensitive search; % and _ typed by the customer are matched literally.
        params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
        const p = `$${params.length}`;
        where.push(`(name ILIKE ${p} ESCAPE '\\' OR line ILIKE ${p} ESCAPE '\\' OR description ILIKE ${p} ESCAPE '\\' OR category ILIKE ${p} ESCAPE '\\')`);
      }
      const sql = `SELECT * FROM products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${SORT_SQL[sort]}`;
      const { rows } = await db.query(sql, params);
      return rows.map(toProduct);
    },

    async get(id) {
      const { rows } = await db.query("SELECT * FROM products WHERE id = $1", [id]);
      return rows[0] ? toProduct(rows[0]) : null;
    },

    async update(id, patch) {
      const cols = { name: "name", price: "price", stock: "stock", badge: "badge", image: "image", description: "description", line: "line", active: "active" };
      const sets = [];
      const params = [];
      for (const [k, v] of Object.entries(patch)) {
        params.push(k === "active" ? (v ? 1 : 0) : v);
        sets.push(`${cols[k]} = $${params.length}`);
      }
      params.push(id);
      const { rowCount } = await db.query(`UPDATE products SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
      return rowCount ? this.get(id) : null;
    },
  };
}
