import crypto from "node:crypto";
import { HttpError } from "../lib/errors.js";
import { computeTotals, estimateDelivery, findPromo, ZONES } from "../lib/pricing.js";
import { normalisePhone } from "../lib/validation.js";

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

export function createOrderService(db) {
  const stmts = {
    product: db.prepare("SELECT id, name, price, stock, sizes, active FROM products WHERE id = ?"),
    takeStock: db.prepare("UPDATE products SET stock = stock - @qty, updated_at = datetime('now') WHERE id = @id AND stock >= @qty"),
    returnStock: db.prepare("UPDATE products SET stock = stock + @qty, updated_at = datetime('now') WHERE id = @id"),
    insertOrder: db.prepare(`INSERT INTO orders (order_no, idempotency_key, status, customer_name, phone, email, ship_method, zone, address, city,
      pay_method, notes, promo_code, subtotal, discount, delivery, vat, total, eta)
      VALUES (@orderNo, @idempotencyKey, @status, @name, @phone, @email, @ship, @zone, @address, @city, @pay, @notes, @promo,
      @subtotal, @discount, @delivery, @vat, @total, @eta)`),
    insertItem: db.prepare(`INSERT INTO order_items (order_id, product_id, name, size, unit_price, qty, line_total)
      VALUES (@orderId, @productId, @name, @size, @unitPrice, @qty, @lineTotal)`),
    byNo: db.prepare("SELECT * FROM orders WHERE order_no = ?"),
    byKey: db.prepare("SELECT * FROM orders WHERE idempotency_key = ?"),
    byRef: db.prepare("SELECT * FROM orders WHERE payment_ref = ?"),
    items: db.prepare("SELECT product_id, name, size, unit_price, qty, line_total FROM order_items WHERE order_id = ? ORDER BY id"),
    setStatus: db.prepare("UPDATE orders SET status = @status, updated_at = datetime('now'), paid_at = CASE WHEN @status = 'paid' THEN datetime('now') ELSE paid_at END WHERE id = @id"),
    setRef: db.prepare("UPDATE orders SET payment_ref = ?, updated_at = datetime('now') WHERE id = ?"),
    staleUnpaid: db.prepare("SELECT id FROM orders WHERE status = 'pending_payment' AND created_at < datetime('now', ?)"),
  };

  /** Resolves cart lines against the catalogue and checks stock. Throws 409 with details if anything is unavailable. */
  function priceLines(items) {
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
      const p = stmts.product.get(it.productId);
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

  function serialise(row) {
    return {
      orderNo: row.order_no,
      status: row.status,
      customer: { name: row.customer_name, email: row.email, phone: row.phone },
      delivery: { method: row.ship_method, zone: row.zone, zoneLabel: ZONES[row.zone].label, address: row.address, city: row.city, eta: row.eta },
      payment: { method: row.pay_method, reference: row.payment_ref, paidAt: row.paid_at },
      promoCode: row.promo_code,
      notes: row.notes,
      items: stmts.items.all(row.id).map((i) => ({ productId: i.product_id, name: i.name, size: i.size, unitPrice: i.unit_price, qty: i.qty, lineTotal: i.line_total })),
      totals: { subtotal: row.subtotal, discount: row.discount, delivery: row.delivery, vat: row.vat, total: row.total },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const changeStatus = db.transaction((row, status) => {
    if (row.status === status) return;
    if (!TRANSITIONS[row.status].includes(status)) {
      throw new HttpError(409, "invalid_transition", `An order that is ${row.status.replace("_", " ")} can't be marked ${status.replace("_", " ")}.`);
    }
    if (status === "cancelled") {
      for (const it of stmts.items.all(row.id)) stmts.returnStock.run({ id: it.product_id, qty: it.qty });
    }
    stmts.setStatus.run({ id: row.id, status });
  });

  return {
    quote({ items, delivery = {}, promoCode }) {
      const lines = priceLines(items);
      const promo = findPromo(promoCode);
      if (promoCode && !promo) throw new HttpError(400, "invalid_promo", "That promo code isn't valid.");
      const totals = computeTotals(lines, { promo, zone: delivery.zone || "lagos", ship: delivery.method || "std" });
      return { items: lines.map(({ stock, ...l }) => l), promo: promo && { code: promo.code, pct: promo.pct }, totals };
    },

    /** Creates an order and reserves stock in one transaction. Same idempotency key returns the same order. */
    create: db.transaction((input, { idempotencyKey } = {}) => {
      if (idempotencyKey) {
        const existing = stmts.byKey.get(idempotencyKey);
        if (existing) return { order: serialise(existing), created: false };
      }
      const promo = findPromo(input.promoCode);
      if (input.promoCode && !promo) throw new HttpError(400, "invalid_promo", "That promo code isn't valid.");

      const lines = priceLines(input.items);
      const { method: ship, zone } = input.delivery;
      const totals = computeTotals(lines, { promo, zone, ship });

      for (const l of lines) {
        const ok = stmts.takeStock.run({ id: l.productId, qty: l.qty }).changes === 1;
        if (!ok) throw new HttpError(409, "cart_unavailable", "Some items in your bag just sold out.", [{ productId: l.productId, reason: "insufficient_stock" }]);
      }

      const status = { card: "pending_payment", transfer: "awaiting_transfer", pod: "confirmed" }[input.payment.method];
      const orderNo = newOrderNo();
      const { lastInsertRowid } = stmts.insertOrder.run({
        orderNo, idempotencyKey: idempotencyKey || null, status,
        name: input.customer.name, phone: normalisePhone(input.customer.phone), email: input.customer.email,
        ship, zone,
        address: ship === "pickup" ? null : input.delivery.address,
        city: ship === "pickup" ? null : input.delivery.city,
        pay: input.payment.method, notes: input.notes || null, promo: promo?.code || null,
        ...totals,
        eta: estimateDelivery({ zone, ship }),
      });
      for (const l of lines) stmts.insertItem.run({ orderId: lastInsertRowid, ...l });
      return { order: serialise(stmts.byNo.get(orderNo)), created: true };
    }),

    get(orderNo) {
      const row = stmts.byNo.get(orderNo);
      return row ? serialise(row) : null;
    },

    getByRef(reference) {
      const row = stmts.byRef.get(reference);
      return row ? serialise(row) : null;
    },

    setPaymentRef(orderNo, reference) {
      const row = stmts.byNo.get(orderNo);
      stmts.setRef.run(reference, row.id);
    },

    setStatus(orderNo, status) {
      const row = stmts.byNo.get(orderNo);
      if (!row) return null;
      changeStatus(row, status);
      return serialise(stmts.byNo.get(orderNo));
    },

    list({ status, limit = 50, offset = 0 } = {}) {
      const rows = status
        ? db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(status, limit, offset)
        : db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
      const total = status
        ? db.prepare("SELECT COUNT(*) n FROM orders WHERE status = ?").get(status).n
        : db.prepare("SELECT COUNT(*) n FROM orders").get().n;
      return { orders: rows.map(serialise), total };
    },

    /** Cancels card orders that were never paid, releasing their stock. Returns how many were cancelled. */
    expireUnpaid(minutes) {
      const stale = stmts.staleUnpaid.all(`-${minutes} minutes`);
      for (const { id } of stale) {
        const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
        changeStatus(row, "cancelled");
      }
      return stale.length;
    },
  };
}
