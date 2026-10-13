import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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
  rank        REAL NOT NULL DEFAULT 100,
  sizes       TEXT,                                       -- JSON array or NULL
  facts       TEXT NOT NULL DEFAULT '[]',                 -- JSON array of [label, value]
  image       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
  paid_at         TEXT,
  eta             TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_email ON orders(email);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
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

export function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
