import crypto from "node:crypto";
import { HttpError } from "../lib/errors.js";
import { computeTotals, estimateDelivery, findPromo, ZONES } from "../lib/pricing.js";
import { normalisePhone } from "../lib/validation.js";
import { transaction } from "../db/database.js";

// Allowed status changes. Anything else is rejected.
const TRANSITIONS = {
  pending_payment: ["paid", "cancelled"],
  awaiting_transfer: ["paid", "cancelled"],
  confirmed: ["shipped", "cancelled"], // pay on delivery
  paid: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
function newOrderNo() {
  const bytes = crypto.randomBytes(8);
  return "SI-" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

const SQL = {
  product: "SELECT id, name, price, stock, sizes, active FROM products WHERE id = $1",
  takeStock: "UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1 AND stock >= $2",
  returnStock: "UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1",
  insertOrder: `INSERT INTO orders (order_no, idempotency_key, status, customer_name, phone, email, ship_method, zone, address, city,
    pay_method, notes, promo_code, subtotal, discount, delivery, vat, total, eta)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
  insertItem: `INSERT INTO order_items (order_id, product_id, name, size, unit_price, qty, line_total)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  byNo: "SELECT * FROM orders WHERE order_no = $1",
  byNoForUpdate: "SELECT * FROM orders WHERE order_no = $1 FOR UPDATE",
  byIdForUpdate: "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
  byKey: "SELECT * FROM orders WHERE idempotency_key = $1",
  byRef: "SELECT * FROM orders WHERE payment_ref = $1",
  items: "SELECT product_id, name, size, unit_price, qty, line_total FROM order_items WHERE order_id = $1 ORDER BY id",
  setStatus: "UPDATE orders SET status = $2, updated_at = now(), paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END WHERE id = $1",
  setRef: "UPDATE orders SET payment_ref = $1, updated_at = now() WHERE id = $2",
  staleUnpaid: "SELECT id FROM orders WHERE status = 'pending_payment' AND created_at < now() - make_interval(mins => $1)",
};

const one = async (q, sql, params) => (await q.query(sql, params)).rows[0];
const isUniqueViolation = (err, constraint) => err?.code === "23505" && (!constraint || err.constraint === constraint);

export function createOrderService(db) {
  /** Resolves cart lines against the catalogue and checks stock. Throws 409 with details if anything is unavailable. */
  async function priceLines(q, items) {
    // Merge duplicate lines (same product and size).
    const merged = new Map();
    for (const it of items) {
      const key = `${it.productId}|${it.size ?? ""}`;
      merged.set(key, { ...it, qty: (merged.get(key)?.qty || 0) + it.qty });
    }
    const totalsByProduct = new Map();
    const problems = [];
    const lines = [];
    for (const it of merged.values()) {
      const p = await one(q, SQL.product, [it.productId]);
      if (!p || !p.active) { problems.push({ productId: it.productId, reason: "unavailable" }); continue; }
      const sizes = p.sizes ? JSON.parse(p.sizes) : null;
      if (sizes && !sizes.includes(it.size)) { problems.push({ productId: p.id, reason: "size_required", sizes }); continue; }
      if (!sizes && it.size) { problems.push({ productId: p.id, reason: "no_sizes" }); continue; }
      totalsByProduct.set(p.id, (totalsByProduct.get(p.id) || 0) + it.qty);
      lines.push({ productId: p.id, name: p.name, size: it.size ?? null, unitPrice: p.price, qty: it.qty, lineTotal: p.price * it.qty, stock: p.stock });
    }
    for (const [id, qty] of totalsByProduct) {
      const stock = lines.find((l) => l.productId === id).stock;
      if (qty > stock) problems.push({ productId: id, reason: "insufficient_stock", available: stock });
    }
    if (problems.length) {
      throw new HttpError(409, "cart_unavailable", "Some items in your bag are no longer available as chosen.", problems);
    }
    return lines;
  }

  async function serialise(q, row) {
    const { rows: items } = await q.query(SQL.items, [row.id]);
    return {
      orderNo: row.order_no,
      status: row.status,
      customer: { name: row.customer_name, email: row.email, phone: row.phone },
      delivery: { method: row.ship_method, zone: row.zone, zoneLabel: ZONES[row.zone].label, address: row.address, city: row.city, eta: row.eta },
      payment: { method: row.pay_method, reference: row.payment_ref, paidAt: row.paid_at },
      promoCode: row.promo_code,
      notes: row.notes,
      items: items.map((i) => ({ productId: i.product_id, name: i.name, size: i.size, unitPrice: i.unit_price, qty: i.qty, lineTotal: i.line_total })),
      totals: { subtotal: row.subtotal, discount: row.discount, delivery: row.delivery, vat: row.vat, total: row.total },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Changes the status of an order row that the caller has locked (SELECT ... FOR UPDATE). */
  async function changeStatus(client, row, status) {
    if (row.status === status) return;
    if (!TRANSITIONS[row.status].includes(status)) {
      throw new HttpError(409, "invalid_transition", `An order that is ${row.status.replace("_", " ")} can't be marked ${status.replace("_", " ")}.`);
    }
    if (status === "cancelled") {
      const { rows: items } = await client.query(SQL.items, [row.id]);
      for (const it of items) await client.query(SQL.returnStock, [it.product_id, it.qty]);
    }
    await client.query(SQL.setStatus, [row.id, status]);
  }

  async function findByKey(idempotencyKey) {
    const row = await one(db, SQL.byKey, [idempotencyKey]);
    return row ? { order: await serialise(db, row), created: false } : null;
  }

  return {
    async quote({ items, delivery = {}, promoCode }) {
      const lines = await priceLines(db, items);
      const promo = findPromo(promoCode);
      if (promoCode && !promo) throw new HttpError(400, "invalid_promo", "That promo code isn't valid.");
      const totals = computeTotals(lines, { promo, zone: delivery.zone || "lagos", ship: delivery.method || "std" });
      return { items: lines.map(({ stock, ...l }) => l), promo: promo && { code: promo.code, pct: promo.pct }, totals };
    },

    /** Creates an order and reserves stock in one transaction. Same idempotency key returns the same order. */
    async create(input, { idempotencyKey } = {}) {
      if (idempotencyKey) {
        const existing = await findByKey(idempotencyKey);
        if (existing) return existing;
      }
      const promo = findPromo(input.promoCode);
      if (input.promoCode && !promo) throw new HttpError(400, "invalid_promo", "That promo code isn't valid.");

      try {
        return await transaction(db, async (client) => {
          const lines = await priceLines(client, input.items);
          const { method: ship, zone } = input.delivery;
          const totals = computeTotals(lines, { promo, zone, ship });

          // Each UPDATE only succeeds if enough stock is left, even with several servers taking orders at once.
          for (const l of lines) {
            const { rowCount } = await client.query(SQL.takeStock, [l.productId, l.qty]);
            if (rowCount !== 1) throw new HttpError(409, "cart_unavailable", "Some items in your bag just sold out.", [{ productId: l.productId, reason: "insufficient_stock" }]);
          }

          const status = { card: "pending_payment", transfer: "awaiting_transfer", pod: "confirmed" }[input.payment.method];
          const orderNo = newOrderNo();
          const { id: orderId } = await one(client, SQL.insertOrder, [
            orderNo, idempotencyKey || null, status,
            input.customer.name, normalisePhone(input.customer.phone), input.customer.email,
            ship, zone,
            ship === "pickup" ? null : input.delivery.address,
            ship === "pickup" ? null : input.delivery.city,
            input.payment.method, input.notes || null, promo?.code || null,
            totals.subtotal, totals.discount, totals.delivery, totals.vat, totals.total,
            estimateDelivery({ zone, ship }),
          ]);
          for (const l of lines) {
            await client.query(SQL.insertItem, [orderId, l.productId, l.name, l.size, l.unitPrice, l.qty, l.lineTotal]);
          }
          return { order: await serialise(client, await one(client, SQL.byNo, [orderNo])), created: true };
        });
      } catch (err) {
        // Two requests with the same key arrived together and the other one won: return its order.
        if (idempotencyKey && isUniqueViolation(err, "orders_idempotency_key_key")) {
          const existing = await findByKey(idempotencyKey);
          if (existing) return existing;
        }
        throw err;
      }
    },

    async get(orderNo) {
      const row = await one(db, SQL.byNo, [orderNo]);
      return row ? serialise(db, row) : null;
    },

    async getByRef(reference) {
      const row = await one(db, SQL.byRef, [reference]);
      return row ? serialise(db, row) : null;
    },

    async setPaymentRef(orderNo, reference) {
      const row = await one(db, SQL.byNo, [orderNo]);
      await db.query(SQL.setRef, [reference, row.id]);
    },

    async setStatus(orderNo, status) {
      const found = await transaction(db, async (client) => {
        // FOR UPDATE: if the webhook and a customer's browser confirm the same payment at once, they take turns.
        const row = await one(client, SQL.byNoForUpdate, [orderNo]);
        if (!row) return false;
        await changeStatus(client, row, status);
        return true;
      });
      return found ? this.get(orderNo) : null;
    },

    async list({ status, limit = 50, offset = 0 } = {}) {
      const where = status ? "WHERE status = $1" : "";
      const filter = status ? [status] : [];
      const n = filter.length;
      const { rows } = await db.query(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT $${n + 1} OFFSET $${n + 2}`, [...filter, limit, offset]);
      const { rows: [{ total }] } = await db.query(`SELECT COUNT(*) AS total FROM orders ${where}`, filter);
      return { orders: await Promise.all(rows.map((r) => serialise(db, r))), total };
    },

    /** Cancels card orders that were never paid, releasing their stock. Returns how many were cancelled. */
    async expireUnpaid(minutes) {
      const { rows: stale } = await db.query(SQL.staleUnpaid, [minutes]);
      let cancelled = 0;
      for (const { id } of stale) {
        // Every server runs this sweep; the row lock and status re-check make sure stock is returned only once.
        cancelled += await transaction(db, async (client) => {
          const row = await one(client, SQL.byIdForUpdate, [id]);
          if (row?.status !== "pending_payment") return 0;
          await changeStatus(client, row, "cancelled");
          return 1;
        });
      }
      return cancelled;
    },
  };
}
