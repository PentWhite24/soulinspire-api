import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { openDatabase } from "../src/db/database.js";
import { seedProducts } from "../src/db/seed.js";
import { createApp } from "../src/app.js";

const ADMIN = "test-admin-key";
let app, db;

function makeApp(extra = {}) {
  db = openDatabase(":memory:");
  seedProducts(db);
  const config = {
    env: "test", corsOrigins: ["http://localhost:5173"], frontendUrl: "http://localhost:5173",
    adminApiKey: ADMIN, paystackSecretKey: "", bank: { bankName: "Test Bank", accountName: "Soulinspire Ltd", accountNumber: "0123456789" },
    pickup: { address: "Lekki", hours: "10–6" }, ...extra.config,
  };
  return createApp({ db, config, fetchImpl: extra.fetchImpl }).app;
}

const order = (over = {}) => ({
  customer: { name: "Ada Obi", phone: "0803 123 4567", email: "Ada@Example.com" },
  delivery: { method: "std", zone: "lagos", address: "12 Admiralty Way", city: "Lekki" },
  payment: { method: "transfer" },
  items: [{ productId: "journal-rooted", qty: 2 }, { productId: "tee-soulwork", size: "M", qty: 1 }],
  ...over,
});

beforeEach(() => { app = makeApp(); });

test("health check", async () => {
  const res = await request(app).get("/api/health").expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.payments, "demo");
});

test("lists, filters and sorts products", async () => {
  const all = await request(app).get("/api/products").expect(200);
  assert.equal(all.body.products.length, 12);
  assert.equal(all.body.products[0].id, "journal-rooted");

  const apparel = await request(app).get("/api/products?category=apparel&sort=low").expect(200);
  assert.deepEqual(apparel.body.products.map((p) => p.price), [11000, 22000, 38000]);

  // The gift box mentions the candle in its description, so it matches too.
  const search = await request(app).get("/api/products?q=candle").expect(200);
  assert.deepEqual(search.body.products.map((p) => p.id), ["candle-still", "box-selfcare"]);

  const pct = await request(app).get("/api/products?q=100%25").expect(200);
  assert.ok(pct.body.products.every((p) => /100%/.test(p.name + p.line + p.desc + p.cat)), "% is matched literally");

  await request(app).get("/api/products/nope").expect(404);
});

test("quote matches the storefront's pricing", async () => {
  const res = await request(app).post("/api/orders/quote")
    .send({ items: [{ productId: "box-selfcare", qty: 1 }, { productId: "tea-calm", qty: 1 }], promoCode: "soul10", delivery: { zone: "rivers", method: "std" } })
    .expect(200);
  // 51,500 subtotal, 5,150 off → 46,350 (under free-delivery threshold), delivery 3,000, VAT 3,476
  assert.deepEqual(res.body.totals, { subtotal: 51500, discount: 5150, delivery: 3000, vat: 3476, total: 52826 });
});

test("rejects bad promo codes", async () => {
  await request(app).post("/api/promo/validate").send({ code: "FREESTUFF" }).expect(404);
  const ok = await request(app).post("/api/promo/validate").send({ code: "soul10" }).expect(200);
  assert.equal(ok.body.promo.pct, 0.1);
});

test("places a bank-transfer order, reserves stock, and recomputes totals server-side", async () => {
  const res = await request(app).post("/api/orders").send(order()).expect(201);
  const o = res.body.order;
  assert.match(o.orderNo, /^SI-[A-Z2-9]{8}$/);
  assert.equal(o.status, "awaiting_transfer");
  assert.equal(o.customer.email, "ada@example.com");
  assert.equal(o.customer.phone, "+2348031234567");
  assert.equal(o.totals.subtotal, 12500 * 2 + 22000);
  assert.equal(o.totals.delivery, 2500);
  assert.equal(res.body.payment.bankDetails.reference, o.orderNo);

  const p = await request(app).get("/api/products/journal-rooted");
  assert.equal(p.body.product.stock, 22);

  // Lookup needs the matching email
  await request(app).get(`/api/orders/${o.orderNo}`).expect(404);
  await request(app).get(`/api/orders/${o.orderNo}?email=ada@example.com`).expect(200);
});

test("ignores prices sent by the client", async () => {
  const res = await request(app).post("/api/orders")
    .send(order({ items: [{ productId: "hoodie-grace", size: "L", qty: 1, price: 1 }], totals: { total: 1 } })).expect(201);
  assert.equal(res.body.order.totals.subtotal, 38000);
});

test("validation errors come back per field", async () => {
  const res = await request(app).post("/api/orders")
    .send(order({ customer: { name: "A", phone: "12345", email: "nope" }, delivery: { method: "std", zone: "lagos", address: "", city: "" } }))
    .expect(400);
  const f = res.body.error.fields;
  for (const k of ["customer.name", "customer.phone", "customer.email", "delivery.address", "delivery.city"]) assert.ok(f[k], k);
});

test("pay on delivery is refused outside covered states", async () => {
  const res = await request(app).post("/api/orders").send(order({ payment: { method: "pod" }, delivery: { method: "std", zone: "other", address: "1 Ring Rd", city: "Ibadan" } })).expect(400);
  assert.ok(res.body.error.fields["payment.method"]);
});

test("sized products need a valid size", async () => {
  const res = await request(app).post("/api/orders").send(order({ items: [{ productId: "tee-soulwork", qty: 1 }] })).expect(409);
  assert.equal(res.body.error.details[0].reason, "size_required");
});

test("cannot buy more than is in stock", async () => {
  const res = await request(app).post("/api/orders").send(order({ items: [{ productId: "tea-calm", qty: 4 }] })).expect(409);
  assert.deepEqual(res.body.error.details[0], { productId: "tea-calm", reason: "insufficient_stock", available: 3 });
  const p = await request(app).get("/api/products/tea-calm");
  assert.equal(p.body.product.stock, 3, "stock untouched after a failed order");
});

test("the same Idempotency-Key never creates two orders", async () => {
  const a = await request(app).post("/api/orders").set("Idempotency-Key", "abc").send(order()).expect(201);
  const b = await request(app).post("/api/orders").set("Idempotency-Key", "abc").send(order()).expect(200);
  assert.equal(a.body.order.orderNo, b.body.order.orderNo);
  const p = await request(app).get("/api/products/journal-rooted");
  assert.equal(p.body.product.stock, 22);
});

test("demo card payment: order is pending until verified", async () => {
  const res = await request(app).post("/api/orders").send(order({ payment: { method: "card" } })).expect(201);
  assert.equal(res.body.order.status, "pending_payment");
  const ref = res.body.payment.reference;
  assert.ok(res.body.payment.authorizationUrl.includes(ref));
  const v = await request(app).get(`/api/payments/verify/${ref}`).expect(200);
  assert.equal(v.body.paid, true);
  assert.equal(v.body.order.status, "paid");
});

test("Paystack: initialise, verify, and signed webhook", async () => {
  const secret = "sk_test_x";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/transaction/initialize")) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: true, data: { reference: body.reference, authorization_url: "https://checkout.paystack.com/x" } }));
    }
    return new Response(JSON.stringify({ status: true, data: { status: "success", amount: 9999999 * 100, currency: "NGN" } }));
  };
  app = makeApp({ config: { paystackSecretKey: secret }, fetchImpl });
  const res = await request(app).post("/api/orders").send(order({ payment: { method: "card" } })).expect(201);
  assert.equal(res.body.payment.authorizationUrl, "https://checkout.paystack.com/x");

  const payload = JSON.stringify({ event: "charge.success", data: { reference: res.body.payment.reference } });
  await request(app).post("/api/payments/webhook").set("Content-Type", "application/json").set("x-paystack-signature", "bad").send(payload).expect(401);
  const sig = crypto.createHmac("sha512", secret).update(payload).digest("hex");
  await request(app).post("/api/payments/webhook").set("Content-Type", "application/json").set("x-paystack-signature", sig).send(payload).expect(200);

  const o = await request(app).get(`/api/admin/orders/${res.body.order.orderNo}`).set("Authorization", `Bearer ${ADMIN}`).expect(200);
  assert.equal(o.body.order.status, "paid");
  assert.ok(calls.some((u) => u.includes("/transaction/verify/")));
});

test("admin API: auth, status changes, cancelling restores stock", async () => {
  await request(app).get("/api/admin/orders").expect(401);
  await request(app).get("/api/admin/orders").set("Authorization", "Bearer wrong-key-wrong-k").expect(401);

  const { body } = await request(app).post("/api/orders").send(order()).expect(201);
  const no = body.order.orderNo;
  const auth = { Authorization: `Bearer ${ADMIN}` };

  const list = await request(app).get("/api/admin/orders?status=awaiting_transfer").set(auth).expect(200);
  assert.equal(list.body.total, 1);

  await request(app).patch(`/api/admin/orders/${no}`).set(auth).send({ status: "delivered" }).expect(409);
  await request(app).patch(`/api/admin/orders/${no}`).set(auth).send({ status: "cancelled" }).expect(200);
  const p = await request(app).get("/api/products/journal-rooted");
  assert.equal(p.body.product.stock, 24);
});

test("admin can change price and stock", async () => {
  const auth = { Authorization: `Bearer ${ADMIN}` };
  const res = await request(app).patch("/api/admin/products/mug-breathe").set(auth).send({ price: 9000, stock: 50 }).expect(200);
  assert.equal(res.body.product.price, 9000);
  await request(app).patch("/api/admin/products/mug-breathe").set(auth).send({ price: -1 }).expect(400);
  await request(app).patch("/api/admin/products/mug-breathe").set(auth).send({ active: false }).expect(200);
  await request(app).get("/api/products/mug-breathe").expect(404);
});

test("unknown endpoints and bad JSON", async () => {
  await request(app).get("/api/nope").expect(404);
  const res = await request(app).post("/api/orders").set("Content-Type", "application/json").send("{bad").expect(400);
  assert.equal(res.body.error.code, "bad_json");
});
