# Soulinspire API

Express backend for the Soulinspire store: catalogue, stock, pricing, orders, Paystack card payments and staff endpoints. Data lives in SQLite.

The storefront is a separate project (`soulinspire-web`) that calls this API over HTTPS.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env   # optional for local use; every setting has a default
npm run dev            # http://localhost:4000, restarts on file changes
```

On first start the database is created at `data/soulinspire.db` and filled with the starter catalogue.
With no Paystack key, card payments run in demo mode: the order is placed and marked paid when the customer returns.

The default `CORS_ORIGINS` already allows the storefront's dev server (`http://localhost:5173`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start and restart on changes |
| `npm test` | Run the API tests |
| `npm run seed` | Reset products to the starter catalogue (`src/db/catalog.js`) |

## Deploy

Any Node host works (Render, Railway, Fly.io, a VPS). It needs a persistent disk for the SQLite file.

1. Set the environment variables below.
2. Start with `npm start`.
3. In the Paystack dashboard, set the webhook URL to `https://<api-domain>/api/payments/webhook`.
4. Build the storefront with `VITE_API_URL=https://<api-domain>/api`.

| Variable | Example | Notes |
| --- | --- | --- |
| `PORT` | `4000` | Most hosts set this for you |
| `NODE_ENV` | `production` | |
| `DATABASE_FILE` | `/var/data/soulinspire.db` | Put it on the persistent disk and back it up |
| `CORS_ORIGINS` | `https://soulinspire.ng,https://www.soulinspire.com` | Storefront address(es), exact match |
| `FRONTEND_URL` | `https://soulinspire.com` | Where customers return after paying by card |
| `PAYSTACK_SECRET_KEY` | `sk_live_…` | Empty = demo payments |
| `ADMIN_API_KEY` | 64 random hex characters | Empty = admin endpoints off |
| `BANK_NAME`, `BANK_ACCOUNT_NAME`, `BANK_ACCOUNT_NUMBER` | | Shown to customers who pay by transfer |
| `PICKUP_ADDRESS` | `Lekki Phase 1, Lagos` | |
| `UNPAID_ORDER_TTL_MINUTES` | `30` | Unpaid card orders are cancelled after this and their stock released |

Generate an admin key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Project layout

```
src/
  index.js              starts the server, seeds an empty database, runs the unpaid-order sweep
  app.js                Express app: security headers, CORS, rate limits, routes, errors
  config.js             settings from environment variables
  db/database.js        SQLite connection and schema
  db/catalog.js         starter catalogue
  db/seed.js            loads the starter catalogue
  lib/pricing.js        delivery zones, VAT, free-delivery threshold, promo codes, totals
  lib/validation.js     request validation (zod)
  lib/errors.js         error responses
  services/products.js  catalogue queries and updates
  services/orders.js    pricing, stock reservation, order statuses
  services/payments.js  Paystack (or demo) payments and webhook signatures
  routes/               catalog, orders, payments, admin
test/api.test.js
```

## API

All responses are JSON. Errors look like `{ "error": { "code", "message", "fields"?, "details"? } }`.

### Shop

| Method & path | Description |
| --- | --- |
| `GET /api/health` | Status and payment mode (`paystack` or `demo`) |
| `GET /api/products?q=&category=&sort=` | Active products. `sort`: `featured`, `new`, `low`, `high` |
| `GET /api/products/:id` | One product |
| `GET /api/categories` | Category list |
| `GET /api/config` | Delivery zones and fees, VAT rate, free-delivery threshold, pickup point |
| `POST /api/promo/validate` | `{ code }` → `{ promo: { code, pct } }` or 404 |
| `POST /api/orders/quote` | `{ items, delivery: { zone, method }, promoCode }` → server-priced totals |
| `POST /api/orders` | Place an order (below) |
| `GET /api/orders/:orderNo?email=` | Customer order lookup; the email must match |
| `GET /api/payments/verify/:reference` | Called by the storefront after the customer returns from Paystack |
| `POST /api/payments/webhook` | Paystack webhook (signature checked) |

`POST /api/orders` body:

```json
{
  "customer": { "name": "Ada Obi", "phone": "0803 123 4567", "email": "ada@example.com" },
  "delivery": { "method": "std", "zone": "lagos", "address": "12 Admiralty Way", "city": "Lekki" },
  "payment": { "method": "card" },
  "items": [{ "productId": "tee-soulwork", "size": "M", "qty": 1 }],
  "promoCode": "SOUL10",
  "notes": "Gift wrap please"
}
```

- `delivery.method`: `std`, `exp` or `pickup`. `delivery.zone`: `lagos`, `rivers`, `fct`, `other`.
- `payment.method`: `card` (response includes `payment.authorizationUrl` to send the customer to), `transfer` (includes `payment.bankDetails`), `pod` (Lagos, Rivers and FCT only).
- Send an `Idempotency-Key` header, unique per checkout attempt. Repeating it returns the original order instead of creating another.
- Prices and totals sent by the browser are ignored; the server prices everything from the database.
- Stock is reserved when the order is placed.
- `409 cart_unavailable` lists each problem item in `details` (`insufficient_stock` with `available`, `size_required`, `unavailable`).

### Admin

Send `Authorization: Bearer <ADMIN_API_KEY>` with every request.

| Method & path | Description |
| --- | --- |
| `GET /api/admin/orders?status=&limit=&offset=` | List orders, newest first |
| `GET /api/admin/orders/:orderNo` | One order |
| `PATCH /api/admin/orders/:orderNo` | `{ status }`. Cancelling returns the items to stock |
| `GET /api/admin/products` | All products, including hidden ones |
| `PATCH /api/admin/products/:id` | Any of `name, price, stock, badge, image, description, line, active` |

Order statuses and the moves allowed between them:

```
pending_payment   → paid | cancelled         (card)
awaiting_transfer → paid | cancelled         (bank transfer; mark paid when the money arrives)
confirmed         → shipped | cancelled      (pay on delivery)
paid              → shipped | cancelled
shipped           → delivered
```

Mark a bank transfer as received:

```bash
curl -X PATCH https://api.soulinspire.com/api/admin/orders/SI-ABCD2345 \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"paid"}'
```

Set a product photo:

```bash
curl -X PATCH https://api.soulinspire.com/api/admin/products/journal-rooted \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"image":"https://soulinspire.ng/products/rooted-journal.jpg"}'
```
