import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { Pool } from "pg";
import { makeInstamojo, verifyWebhookMac, isVerifiedPaid } from "./provider.js";

const {
  DATABASE_URL,
  INSTAMOJO_API_KEY,
  INSTAMOJO_AUTH_TOKEN,
  INSTAMOJO_BASE_URL = "https://test.instamojo.com",
  PUBLIC_BACKEND_URL,
  FRONTEND_ORIGIN,
  INSTAMOJO_PRIVATE_SALT = "",
  PORT = 8080,
  NODE_ENV = "development",
} = process.env;

const amountPaise = Number(process.env.AMOUNT_PAISE || 29900);

for (const [key, value] of Object.entries({
  DATABASE_URL,
  INSTAMOJO_API_KEY,
  INSTAMOJO_AUTH_TOKEN,
  PUBLIC_BACKEND_URL,
  FRONTEND_ORIGIN,
})) {
  if (!value) {
    throw new Error(`Missing ${key}: see .env`);
  }
}

if (!Number.isInteger(amountPaise) || amountPaise < 900)
  throw new Error("Invalid AMOUNT_PAISE");
const backendOrigin = new URL(PUBLIC_BACKEND_URL).origin;
if (NODE_ENV === "production" && !backendOrigin.startsWith("https://"))
  throw new Error("Production backend must use HTTPS");
const origins = FRONTEND_ORIGIN.split(",").map((x) => new URL(x.trim()).origin);
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 8000,
});
const provider = makeInstamojo({
  baseUrl: INSTAMOJO_BASE_URL,
  apiKey: INSTAMOJO_API_KEY,
  authToken: INSTAMOJO_AUTH_TOKEN,
});
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    methods: ["POST", "GET"],
    allowedHeaders: ["Content-Type"],
  }),
);
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use("/api", (req, res, next) => {
  if (req.method === "POST" && req.path === "/register") {
    // Lightweight in-memory limit for local/single-instance testing. Use shared Redis/WAF in production.
    const now = Date.now(),
      key = req.ip,
      previous = throttle.get(key) || [];
    const recent = previous.filter((t) => now - t < 600000);
    if (recent.length >= 10)
      return res
        .status(429)
        .json({ error: "Too many attempts. Please retry later." });
    recent.push(now);
    throttle.set(key, recent);
  }
  next();
});
const throttle = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of throttle)
    if (now - v.at(-1) > 600000) throttle.delete(k);
}, 600000).unref();

const batches = new Set([
  "6:00 – 7:00 AM",
  "7:00 – 8:00 AM",
  "8:00 – 9:00 AM",
  "6:00 – 7:00 PM",
  "7:00 – 8:00 PM",
  "8:00 – 9:00 PM",
]);
const validId = (s) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
const validPaymentId = (s) =>
  typeof s === "string" && /^[a-zA-Z0-9_-]{6,100}$/.test(s);
function plainError(res, code, text) {
  return res.status(code).json({ error: text });
}

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    environment: INSTAMOJO_BASE_URL.includes("test.") ? "sandbox" : "live",
  }),
);
app.post("/api/register", async (req, res) => {
  const { name, age, phone, batch, consent } = req.body || {};
  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanPhone = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  const cleanAge = Number(age);
  if (
    cleanName.length < 2 ||
    cleanName.length > 100 ||
    !Number.isInteger(cleanAge) ||
    cleanAge < 18 ||
    cleanAge > 90 ||
    !/^[6-9]\d{9}$/.test(cleanPhone) ||
    !batches.has(batch) ||
    consent !== true
  )
    return plainError(
      res,
      400,
      "Please check name, adult age, 10-digit Indian WhatsApp number, batch and consent.",
    );
  let regId = null;
  try {
    const registration = await pool.query(
      `INSERT INTO public.registrations(full_name,age,whatsapp_number,preferred_batch,consent_given) VALUES($1,$2,$3,$4,true) RETURNING id`,
      [cleanName, cleanAge, `+91${cleanPhone}`, batch],
    );
    regId = registration.rows[0].id;
    const request = await provider.createPayment({
      registrationId: regId,
      name: cleanName,
      phone: cleanPhone,
      amountRupees: amountPaise / 100,
      redirectUrl: `${backendOrigin}/payment/return`,
      webhookUrl: INSTAMOJO_PRIVATE_SALT
        ? `${backendOrigin}/api/instamojo/webhook`
        : null,
    });
    await pool.query(
      `INSERT INTO public.payments(registration_id,provider,payment_request_id,amount_paise,currency,status) VALUES($1,'instamojo',$2,$3,'INR','pending')`,
      [regId, request.id, amountPaise],
    );
    return res.status(201).json({ checkoutUrl: request.url });
  } catch (error) {
    console.error("Register/payment creation failed:", error);
console.error("Underlying cause:", error.cause);
    return plainError(
      res,
      502,
      "Unable to start checkout right now. Please retry.",
    );
  }
});

async function confirmPayment(requestId, paymentId) {
  if (!validPaymentId(requestId) || !validPaymentId(paymentId)) return false;
  const record = await pool.query(
    `SELECT p.id,p.amount_paise,p.registration_id,p.status FROM public.payments p WHERE p.payment_request_id=$1`,
    [requestId],
  );
  const row = record.rows[0];
  if (!row) return false;
  if (row.status === "paid") {
    const prior = await pool.query(
      "SELECT payment_id FROM public.payments WHERE id=$1",
      [row.id],
    );
    return prior.rows[0]?.payment_id === paymentId;
  }
  const [payment, request] = await Promise.all([
    provider.getPayment(paymentId, requestId),
    provider.getRequest(requestId),
  ]);
  if (
    !isVerifiedPaid({
      payment,
      request,
      requestId,
      paymentId,
      amountPaise: row.amount_paise,
    })
  )
    return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.payments SET status='paid',payment_id=$2,verified_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING registration_id`,
      [row.id, paymentId],
    );
    if (updated.rowCount === 1)
      await client.query(
        `UPDATE public.registrations SET payment_status='paid',updated_at=NOW() WHERE id=$1`,
        [row.registration_id],
      );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
function renderResult(res, success) {
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", "text/html; charset=utf-8");
  // Server-rendered status; never rely on frontend query parameters to assert successful payment.
  const title = success ? "Congratulations!" : "Payment not confirmed";
  const copy = success
    ? "Your ₹299 registration is confirmed. Welcome to the 15-Day Water & Wellness Challenge. Starting 7 December 2026."
    : "We have not verified a successful payment. If you were charged, contact support with your Instamojo payment ID.";
  const icon = success ? "✓" : "!";
  res
    .status(success ? 200 : 202)
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} · Shilpakar</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box;background:#fff9f2;color:#3b2410;font:16px system-ui,-apple-system,sans-serif}.card{max-width:540px;padding:48px 32px;border-radius:28px;background:white;text-align:center;box-shadow:0 24px 70px #d9731a24}.icon{display:grid;place-items:center;margin:auto;background:#ffead6;color:#bd6011;border-radius:50%;width:72px;height:72px;font-size:36px}h1{font:700 clamp(28px,6vw,43px) Georgia,serif;margin:22px 0 15px}p{line-height:1.8;color:#675342}a{display:inline-block;background:#f28c28;border-radius:50px;color:#29190d;padding:14px 24px;text-decoration:none;font-weight:700;margin-top:16px}</style></head><body><main class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${copy}</p><a href="https://wa.me/917400009160">Contact Shilpakar Support</a></main></body></html>`,
    );
}
app.get("/payment/return", async (req, res) => {
  const requestId = req.query.payment_request_id,
    paymentId = req.query.payment_id;
  try {
    return renderResult(res, await confirmPayment(requestId, paymentId));
  } catch (error) {
    console.error("Payment return verification failed:", error.message);
    return renderResult(res, false);
  }
});
app.post("/api/instamojo/webhook", async (req, res) => {
  if (!INSTAMOJO_PRIVATE_SALT) return res.sendStatus(503);
  if (!verifyWebhookMac(req.body, INSTAMOJO_PRIVATE_SALT))
    return res.sendStatus(401);
  const { payment_request_id, payment_id, status } = req.body;
  try {
    if (status === "Credit")
      await confirmPayment(payment_request_id, payment_id);
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook processing failed:", error.message);
    return res.sendStatus(503);
  }
});
app.use((_req, res) => res.sendStatus(404));
const server = app.listen(Number(PORT), () =>
  console.log(`Shilpakar API listening on ${PORT}`),
);
process.on("SIGTERM", () => {
  server.close();
  pool.end();
});
