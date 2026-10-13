import express, { Router } from "express";
import { asyncHandler, HttpError, notFound } from "../lib/errors.js";

export function paymentRoutes({ orders, payments }) {
  const r = Router();

  async function settle(reference) {
    const order = orders.getByRef(reference);
    if (!order) return null;
    if (order.status !== "pending_payment") return order;
    const result = await payments.verify(reference);
    if (!result.paid) return order;
    if (result.amountNaira != null && result.amountNaira < order.totals.total) {
      console.warn(`Underpayment on ${order.orderNo}: got ₦${result.amountNaira}, expected ₦${order.totals.total}`);
      return order;
    }
    return orders.setStatus(order.orderNo, "paid");
  }

  // Called by the frontend when the customer comes back from the payment page.
  r.get(
    "/payments/verify/:reference",
    asyncHandler(async (req, res) => {
      const order = await settle(req.params.reference);
      if (!order) throw notFound("Payment");
      if (order.status === "cancelled") throw new HttpError(410, "order_cancelled", "This order was cancelled before payment arrived. Contact us and we'll sort it out.");
      res.json({ paid: order.status !== "pending_payment", order });
    })
  );

  // Paystack webhook. Needs the raw body to check the signature.
  r.post(
    "/payments/webhook",
    express.raw({ type: "application/json", limit: "100kb" }),
    asyncHandler(async (req, res) => {
      if (!payments.verifyWebhookSignature(req.body, req.get("x-paystack-signature"))) {
        return res.status(401).json({ error: { code: "bad_signature", message: "Signature check failed." } });
      }
      const event = JSON.parse(req.body.toString("utf8"));
      if (event.event === "charge.success" && event.data?.reference) await settle(event.data.reference);
      res.sendStatus(200);
    })
  );

  return r;
}
