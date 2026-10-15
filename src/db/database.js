import fs from "node:fs";
import pg from "pg";

// COUNT(*) and other BIGINT results arrive as strings by default; every count here is small.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),       -- whole Naira
  line        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  glyph       TEXT,
  c1          TEXT, c2 TEXT, bg TEXT,
  badge       TEXT NOT NULL DEFAULT '',
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  rank        DOUBLE PRECISION NOT NULL DEFAULT 100,
  sizes       TEXT,                                       -- JSON array or NULL
  facts       TEXT NOT NULL DEFAULT '[]',                 -- JSON array of [label, value]
  image       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no        TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  status          TEXT NOT NULL,
  customer_name   TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT NOT NULL,
  ship_method     TEXT NOT NULL,
  zone            TEXT NOT NULL,
  address         TEXT,
  city            TEXT,
  pay_method      TEXT NOT NULL,
  notes           TEXT,
  promo_code      TEXT,
  subtotal        INTEGER NOT NULL,
  discount        INTEGER NOT NULL,
  delivery        INTEGER NOT NULL,
  vat             INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  payment_ref     TEXT UNIQUE,
  paid_at         TIMESTAMPTZ,
  eta             TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_email ON orders(email);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  name        TEXT NOT NULL,
  size        TEXT,
  unit_price  INTEGER NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  line_total  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
`;

/** Opens a connection pool using the settings from config.db. */
export function createPool(db) {
  const ssl = db.ssl
    ? { rejectUnauthorized: true, ...(db.sslCaFile && { ca: fs.readFileSync(db.sslCaFile, "utf8") }) }
    : false;
  const pool = new pg.Pool({
    ...(db.connectionString
      ? { connectionString: db.connectionString }
      : { host: db.host, port: db.port, database: db.database, user: db.user, password: db.password }),
    ssl,
    max: db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // A dropped idle connection (e.g. during an RDS failover) must not crash the process.
  pool.on("error", (err) => console.error("Database connection error:", err.message));
  return pool;
}

// Any number works, as long as every server uses the same one.
const MIGRATION_LOCK_ID = 7_400_001;

/**
 * Creates the tables if they don't exist yet, then runs `afterMigrate` (e.g. seeding).
 * An advisory lock makes servers that start at the same moment take turns.
 */
export async function migrate(pool, { afterMigrate } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
    if (afterMigrate) await afterMigrate(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Runs fn(client) inside BEGIN/COMMIT; rolls back if it throws. */
export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
