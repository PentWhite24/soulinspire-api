import { z } from "zod";
import { PAY_METHODS, POD_ZONES, SHIP_METHODS, ZONES } from "./pricing.js";

const NIGERIAN_MOBILE = /^(\+?234|0)[789][01]\d{8}$/;

// Normalises "0803 123 4567" / "2348031234567" to "+2348031234567".
export function normalisePhone(raw) {
  const digits = raw.replace(/[\s-]/g, "");
  if (digits.startsWith("+234")) return digits;
  if (digits.startsWith("234")) return "+" + digits;
  return "+234" + digits.slice(1);
}

const trimmed = (min, max, msg) => z.string({ required_error: msg }).trim().min(min, msg).max(max);

export const orderInput = z
  .object({
    customer: z.object({
      name: trimmed(2, 120, "Enter your full name."),
      phone: z.string().refine((v) => NIGERIAN_MOBILE.test(v.replace(/[\s-]/g, "")), "Enter a Nigerian mobile number, e.g. 0803 123 4567."),
      email: z.string().trim().toLowerCase().email("Enter an email address like name@example.com.").max(200),
    }),
    delivery: z.object({
      method: z.enum(SHIP_METHODS),
      zone: z.enum(Object.keys(ZONES)),
      address: z.string().trim().max(300).optional().default(""),
      city: z.string().trim().max(120).optional().default(""),
    }),
    payment: z.object({ method: z.enum(PAY_METHODS) }),
    items: z
      .array(
        z.object({
          productId: z.string().min(1).max(80),
          size: z.string().max(10).nullable().optional().default(null),
          qty: z.number().int().min(1).max(50),
        })
      )
      .min(1, "Your bag is empty.")
      .max(50),
    promoCode: z.string().trim().max(40).optional().nullable(),
    notes: z.string().trim().max(500).optional().default(""),
  })
  .superRefine((o, ctx) => {
    if (o.delivery.method !== "pickup") {
      if (o.delivery.address.length < 5) ctx.addIssue({ code: "custom", path: ["delivery", "address"], message: "Enter a street address for delivery." });
      if (o.delivery.city.length < 2) ctx.addIssue({ code: "custom", path: ["delivery", "city"], message: "Enter your city or town." });
    }
    if (o.payment.method === "pod" && !POD_ZONES.includes(o.delivery.zone)) {
      ctx.addIssue({ code: "custom", path: ["payment", "method"], message: "Pay on delivery isn't available in this state. Choose card or bank transfer." });
    }
  });

export const quoteInput = z.object({
  items: orderInput.innerType().shape.items,
  delivery: z.object({ method: z.enum(SHIP_METHODS).default("std"), zone: z.enum(Object.keys(ZONES)).default("lagos") }).default({}),
  promoCode: z.string().trim().max(40).optional().nullable(),
});

export const productQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(40).optional(),
  sort: z.enum(["featured", "new", "low", "high"]).optional().default("featured"),
});

export const productPatch = z
  .object({
    name: z.string().trim().min(2).max(120),
    price: z.number().int().min(0).max(100_000_000),
    stock: z.number().int().min(0).max(1_000_000),
    badge: z.enum(["", "New", "Bestseller"]),
    image: z.string().trim().max(500).nullable(),
    description: z.string().trim().max(2000),
    line: z.string().trim().max(200),
    active: z.boolean(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Send at least one field to change.");

export const ORDER_STATUSES = ["pending_payment", "awaiting_transfer", "confirmed", "paid", "shipped", "delivered", "cancelled"];
export const statusPatch = z.object({ status: z.enum(ORDER_STATUSES) });
