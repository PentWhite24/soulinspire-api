import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { errorHandler, HttpError } from "./lib/errors.js";
import { createProductService } from "./services/products.js";
import { createOrderService } from "./services/orders.js";
import { createPaymentService } from "./services/payments.js";
import { catalogRoutes } from "./routes/catalog.js";
import { orderRoutes } from "./routes/orders.js";
import { paymentRoutes } from "./routes/payments.js";
import { adminRoutes } from "./routes/admin.js";

export function createApp({ db, config, fetchImpl }) {
  const products = createProductService(db);
  const orders = createOrderService(db);
  const payments = createPaymentService({ secretKey: config.paystackSecretKey, frontendUrl: config.frontendUrl, fetchImpl });
  const deps = { db, config, products, orders, payments };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use("/api", cors({ origin: config.corsOrigins, allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"] }));

  // Webhook first: it needs the raw body, so it must run before express.json().
  app.use("/api", paymentRoutes(deps));
  app.use(express.json({ limit: "50kb" }));

  const limit = (max) => rateLimit({ windowMs: 60_000, limit: max, standardHeaders: "draft-7", legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, "rate_limited", "Too many requests. Wait a minute and try again.")) });
  if (config.env !== "test") {
    app.use("/api", limit(300));
    app.use("/api/orders", limit(20));
    app.use("/api/promo", limit(20));
  }

   // Load balancer health check: answers as long as the process is up. It deliberately does not
  // touch the database, so a short database failover doesn't make every server look broken.
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, payments: payments.mode, time: new Date().toISOString() }));
  // Deeper check for people and monitoring: can this server reach the database?
  app.get("/api/ready", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true, database: "reachable" });
    } catch (err) {
      console.error("Readiness check failed:", err.message);
      res.status(503).json({ ok: false, database: "unreachable" });
    }
  });
  app.use("/api", catalogRoutes(deps));
  app.use("/api", orderRoutes(deps));
  app.use("/api/admin", adminRoutes(deps));
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "No such API endpoint.")));

  app.get("/", (_req, res) => res.json({ name: "Soulinspire API", docs: "See README.md", health: "/api/health" }));
  app.use((_req, _res, next) => next(new HttpError(404, "not_found", "Not found.")));

  app.use(errorHandler);
  return { app, services: deps };
}
