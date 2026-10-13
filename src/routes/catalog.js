import { Router } from "express";
import { notFound } from "../lib/errors.js";
import { FREE_DELIVERY_OVER, POD_ZONES, VAT_RATE, ZONES } from "../lib/pricing.js";
import { productQuery } from "../lib/validation.js";
import { INTENTIONS } from "../db/catalog.js";

export function catalogRoutes({ products, config }) {
  const r = Router();

  r.get("/products", (req, res) => {
    const query = productQuery.parse(req.query);
    res.set("Cache-Control", "public, max-age=30");
    res.json({ products: products.list(query) });
  });

  r.get("/products/:id", (req, res) => {
    const p = products.get(req.params.id);
    if (!p || p.active === false) throw notFound("Product");
    res.json({ product: p });
  });

  r.get("/categories", (_req, res) => res.json({ categories: products.categories() }));

  // Everything the checkout needs to show prices before the server confirms them.
  r.get("/config", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      currency: "NGN",
      vatRate: VAT_RATE,
      freeDeliveryOver: FREE_DELIVERY_OVER,
      zones: ZONES,
      payOnDeliveryZones: POD_ZONES,
      pickup: config.pickup,
      intentions: INTENTIONS,
    });
  });

  return r;
}
