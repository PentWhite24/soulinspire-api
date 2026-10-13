import { Router } from "express";
import { z } from "zod";
import { asyncHandler, HttpError, notFound } from "../lib/errors.js";
import { findPromo } from "../lib/pricing.js";
import { orderInput, quoteInput } from "../lib/validation.js";

export function orderRoutes({ orders, payments, config }) {
  const r = Router();

  r.post("/promo/validate", (req, res) => {
    const { code } = z.object({ code: z.string().trim().min(1, "Enter a promo code.").max(40) }).parse(req.body);
    const promo = findPromo(code);
    if (!promo) throw new HttpError(404, "invalid_promo", "That promo code isn't valid.");
    res.json({ promo: { code: promo.code, pct: promo.pct, description: promo.description } });
  });

  // Prices a bag without placing an order.
  r.post("/orders/quote", (req, res) => {
    res.json(orders.quote(quoteInput.parse(req.body)));
  });

  r.post(
    "/orders",
    asyncHandler(async (req, res) => {
      const input = orderInput.parse(req.body);
      const idempotencyKey = req.get("Idempotency-Key")?.slice(0, 100);
      const { order, created } = orders.create(input, { idempotencyKey });

      const next = { method: order.payment.method };
      if (order.payment.method === "card" && order.status === "pending_payment") {
        try {
          const init = await payments.initialize({ orderNo: order.orderNo, email: order.customer.email, amountNaira: order.totals.total });
          orders.setPaymentRef(order.orderNo, init.reference);
          next.reference = init.reference;
          next.authorizationUrl = init.authorizationUrl;
        } catch (err) {
          console.error(err);
          orders.setStatus(order.orderNo, "cancelled"); // release the reserved stock
          throw new HttpError(502, "payment_unavailable", "We couldn't start the card payment. Please try again or choose bank transfer.");
        }
      }
      if (order.payment.method === "transfer") {
        next.bankDetails = { ...config.bank, amount: order.totals.total, reference: order.orderNo };
      }
      if (order.delivery.method === "pickup") next.pickup = config.pickup;

      res.status(created ? 201 : 200).json({ order: orders.get(order.orderNo), payment: next });
    })
  );

  // Order lookup for customers. The email must match so order numbers can't be guessed.
  r.get("/orders/:orderNo", (req, res) => {
    const email = String(req.query.email || "").trim().toLowerCase();
    const order = orders.get(req.params.orderNo);
    if (!order || !email || order.customer.email !== email) throw notFound("Order");
    res.json({ order });
  });

  return r;
}
