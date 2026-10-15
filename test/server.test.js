// Simulates two servers behind the load balancer: two app instances, each with its own
// connection pool, sharing one PostgreSQL database. Requests are fired at both at the same time.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createPool, migrate } from "../src/db/database.js";
import { seedProducts } from "../src/db/seed.js";
import { createApp } from "../src/app.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soulinspire_test";
const config = {
  env: "test", corsOrigins: [], frontendUrl: "http://localhost:5173", adminApiKey: "k", paystackSecretKey: "",
  bank: { bankName: "B", accountName: "A", accountNumber: "0" }, pickup: { address: "L", hours: "h" },
};

const poolA = createPool({ connectionString: TEST_DATABASE_URL, poolMax: 5 });
const poolB = createPool({ connectionString: TEST_DATABASE_URL, poolMax: 5 });
const serverA = createApp({ db: poolA, config });
const serverB = createApp({ db: poolB, config });
const pick = (i) => (i % 2 ? serverB : serverA).app;

before(() => Promise.all([migrate(poolA), migrate(poolB)])); // both servers start at once
after(() => Promise.all([poolA.end(), poolB.end()]));
beforeEach(async () => {
  await poolA.query("TRUNCATE order_items, orders, products RESTART IDENTITY CASCADE");
  await seedProducts(poolA);
});

const order = (productId, extra = {}) => ({
  customer: { name: "Ada Obi", phone: "0803 123 4567", email: "ada@example.com" },
  delivery: { method: "std", zone: "lagos", address: "12 Admiralty Way", city: "Lekki" },
  payment: { method: "transfer" },
  items: [{ productId, qty: 1 }],
  ...extra,
});

test("never sells more than the stock, even when both servers take orders at once", async () => {
  // tea-calm starts with 3 in stock; 12 customers try to buy one each.
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => request(pick(i)).post("/api/orders").send(order("tea-calm"))),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.ok(results.every((r) => r.status === 201 || r.status === 409));
  const p = await request(serverA.app).get("/api/products/tea-calm").expect(200);
  assert.equal(p.body.product.stock, 0);
});

test("an order placed on one server is visible on the other", async () => {
  const placed = await request(serverA.app).post("/api/orders").send(order("mug-breathe")).expect(201);
  const no = placed.body.order.orderNo;
  await request(serverB.app).get(`/api/orders/${no}?email=ada@example.com`).expect(200);
});

test("a repeated Idempotency-Key creates one order, whichever server receives it", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => request(pick(i)).post("/api/orders").set("Idempotency-Key", "same-checkout").send(order("candle-still"))),
  );
  assert.equal(new Set(results.map((r) => r.body.order.orderNo)).size, 1);
  const p = await request(serverA.app).get("/api/products/candle-still").expect(200);
  assert.equal(p.body.product.stock, 3, "stock taken once (4 → 3)");
});

test("both servers sweeping unpaid orders return the stock only once", async () => {
  const placed = await request(serverA.app).post("/api/orders").send(order("cards-intent", { payment: { method: "card" } })).expect(201);
  await poolA.query("UPDATE orders SET created_at = now() - interval '2 hours' WHERE order_no = $1", [placed.body.order.orderNo]);
  const [a, b] = await Promise.all([serverA.services.orders.expireUnpaid(30), serverB.services.orders.expireUnpaid(30)]);
  assert.equal(a + b, 1);
  const p = await request(serverB.app).get("/api/products/cards-intent").expect(200);
  assert.equal(p.body.product.stock, 35, "35 → 34 → 35, not 36");
});
