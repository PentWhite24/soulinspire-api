import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, HttpError, notFound } from "../lib/errors.js";
import { ORDER_STATUSES, productPatch, statusPatch } from "../lib/validation.js";

// Store-staff endpoints. Every request needs: Authorization: Bearer <ADMIN_API_KEY>
export function adminRoutes({ orders, products, config }) {
  const r = Router();

  r.use((req, _res, next) => {
    if (!config.adminApiKey) throw new HttpError(503, "admin_disabled", "Set ADMIN_API_KEY to use the admin API.");
    const given = Buffer.from((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(config.adminApiKey);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new HttpError(401, "unauthorised", "A valid admin API key is required.");
    }
    next();
  });

  r.get("/orders", asyncHandler(async (req, res) => {
    const q = z.object({
      status: z.enum(ORDER_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json(await orders.list(q));
  }));

  r.get("/orders/:orderNo", asyncHandler(async (req, res) => {
    const order = await orders.get(req.params.orderNo);
    if (!order) throw notFound("Order");
    res.json({ order });
  }));

  r.patch("/orders/:orderNo", asyncHandler(async (req, res) => {
    const { status } = statusPatch.parse(req.body);
    const order = await orders.setStatus(req.params.orderNo, status);
    if (!order) throw notFound("Order");
    res.json({ order });
  }));

  r.get("/products", asyncHandler(async (_req, res) => res.json({ products: await products.list({ includeInactive: true }) })));

  r.patch("/products/:id", asyncHandler(async (req, res) => {
    const product = await products.update(req.params.id, productPatch.parse(req.body));
    if (!product) throw notFound("Product");
    res.json({ product });
  }));

  return r;
}
