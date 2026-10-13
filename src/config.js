import "dotenv/config";

const env = process.env;

export const config = {
  env: env.NODE_ENV || "development",
  port: Number(env.PORT || 4000),
  databaseFile: env.DATABASE_FILE || "data/soulinspire.db",
  // Comma-separated list of storefront origins allowed to call the API from a browser.
  corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  // Where the customer is sent back to after paying by card.
  frontendUrl: env.FRONTEND_URL || "http://localhost:5173",
  adminApiKey: env.ADMIN_API_KEY || "",
  paystackSecretKey: env.PAYSTACK_SECRET_KEY || "",
  // Shown to customers who choose bank transfer.
  bank: {
    bankName: env.BANK_NAME || "Example Bank",
    accountName: env.BANK_ACCOUNT_NAME || "Soulinspire Ltd",
    accountNumber: env.BANK_ACCOUNT_NUMBER || "0000000000",
  },
  pickup: {
    address: env.PICKUP_ADDRESS || "Lekki Phase 1, Lagos",
    hours: "Mon–Sat, 10am–6pm",
  },
  // Unpaid card orders are cancelled and their stock released after this many minutes.
  unpaidOrderTtlMinutes: Number(env.UNPAID_ORDER_TTL_MINUTES || 30),
};
