import crypto from "node:crypto";

// Card payments go through Paystack when PAYSTACK_SECRET_KEY is set.
// Without a key the server runs in demo mode: card orders get a fake checkout
// link that marks them paid straight away, so the full flow can be tried locally.

const PAYSTACK = "https://api.paystack.co";

export function createPaymentService({ secretKey, frontendUrl, fetchImpl = fetch }) {
  const live = Boolean(secretKey);

  async function paystack(path, init = {}) {
    const res = await fetchImpl(PAYSTACK + path, {
      ...init,
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) {
      const err = new Error(`Paystack ${path} failed: ${body.message || res.status}`);
      err.paystack = body;
      throw err;
    }
    return body.data;
  }

  return {
    mode: live ? "paystack" : "demo",

    /** Starts a card payment and returns where to send the customer. */
    async initialize({ orderNo, email, amountNaira }) {
      const reference = `${orderNo}-${crypto.randomBytes(3).toString("hex")}`;
      const callbackUrl = `${frontendUrl.replace(/\/$/, "")}/?order=${encodeURIComponent(orderNo)}`;
      if (!live) {
        return { reference, authorizationUrl: `${callbackUrl}&reference=${reference}&demo=1` };
      }
      const data = await paystack("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email,
          amount: amountNaira * 100, // Paystack expects kobo
          currency: "NGN",
          reference,
          callback_url: callbackUrl,
          metadata: { order_no: orderNo },
        }),
      });
      return { reference: data.reference, authorizationUrl: data.authorization_url };
    },

    /** Asks the provider whether a payment succeeded. Returns { paid, amountNaira }. */
    async verify(reference) {
      if (!live) return { paid: true, amountNaira: null, demo: true };
      const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
      return { paid: data.status === "success", amountNaira: Math.round(data.amount / 100), currency: data.currency };
    },

    /** Checks the x-paystack-signature header against the raw request body. */
    verifyWebhookSignature(rawBody, signature) {
      if (!live || !signature) return false;
      const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}
