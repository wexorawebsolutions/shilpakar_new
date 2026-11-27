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
  INSTAMOJO_BASE_URL = "https://www.instamojo.com",
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
  baseUrl: INSTAMOJO_BASE_URL.trim(),
  apiKey: INSTAMOJO_API_KEY.trim(),
  authToken: INSTAMOJO_AUTH_TOKEN.trim(),
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
  const { name, age, phone, email, batch, consent } = req.body || {};
  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanPhone = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  const cleanEmail = typeof email === "string" ? email.trim() : "";
  const cleanAge = Number(age);
  if (
    cleanName.length < 2 ||
    cleanName.length > 100 ||
    !Number.isInteger(cleanAge) ||
    cleanAge < 18 ||
    cleanAge > 90 ||
    !/^[6-9]\d{9}$/.test(cleanPhone) ||
    cleanEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) ||
    !batches.has(batch) ||
    consent !== true
  )
    return plainError(
      res,
      400,
      "Please check name, adult age, WhatsApp number, email, batch and consent.",
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
      email: cleanEmail,
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

  const groupUrl = (
    process.env.SHILPAKAR_WHATSAPP_GROUP_URL || ""
  ).trim();

  const validGroupUrl =
    /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/
      .test(groupUrl);

  const whatsappMessage = encodeURIComponent(
    "Hello Sir, I have successfully completed my enrollment for the 15 Days Water Challenge."
  );

  const contactUrl =
    `https://wa.me/917400009160?text=${whatsappMessage}`;

  const title = success
    ? "Enrollment Confirmed!"
    : "Payment not confirmed";

  const content = success
    ? `
      <div class="icon success">✓</div>
      <span class="tag">PAYMENT SUCCESSFUL</span>

      <h1>Enrollment Confirmed!</h1>

      <p>
        Congratulations! You have successfully enrolled
        in the <strong>15 Days Water Challenge.</strong>
      </p>

      <div class="details">
        <div>📅 <strong>Starts:</strong> 7 December 2026</div>
        <div>👨‍🏫 <strong>Coach:</strong> Anand</div>
        <div>🎥 <strong>Mode:</strong> Online Live Sessions</div>
        <div>✅ <strong>Status:</strong> Payment Verified</div>
      </div>

      <h3>What's next?</h3>
      <p>
        Join our official WhatsApp group to receive
        class links and important instructions.
      </p>

      ${validGroupUrl ? `
        <a class="btn whatsapp"
           href="${groupUrl}"
           target="_blank"
           rel="noopener noreferrer">
          Join Official WhatsApp Group →
        </a>
      ` : ""}

      <a class="btn secondary"
         href="${contactUrl}"
         target="_blank"
         rel="noopener noreferrer">
        Connect with Coach Anand
      </a>

      <p class="footer">
        Welcome to the Shilpakar Fitness family!
      </p>
    `
    : `
      <div class="icon warning">!</div>
      <h1>Payment not confirmed</h1>
      <p>
        We have not verified your payment yet.
        If your account was charged, please do not
        make another payment.
      </p>
      <a class="btn"
         href="https://wa.me/917400009160">
        Contact Shilpakar Support
      </a>
    `;

  return res.status(success ? 200 : 202).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport"
            content="width=device-width, initial-scale=1">
      <meta name="robots" content="noindex,nofollow">
      <meta name="referrer" content="no-referrer">

      <title>${title} | Shilpakar Fitness</title>

      <style>
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background: linear-gradient(
            145deg, #fffaf4, #ffead7
          );
          color: #3b2410;
          font-family: system-ui, sans-serif;
        }

        .card {
          width: 100%;
          max-width: 540px;
          background: #fff;
          padding: 40px 30px;
          border-radius: 28px;
          text-align: center;
          box-shadow: 0 20px 70px #d9731a20;
          animation: appear .6s ease both;
        }

        @keyframes appear {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .icon {
          width: 82px;
          height: 82px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          margin: 0 auto 20px;
          font-size: 42px;
        }

        .success {
          background: #e7f8ed;
          color: #16a34a;
        }

        .warning {
          background: #ffead6;
          color: #d9731a;
        }

        .tag {
          font-size: 11px;
          letter-spacing: 2px;
          font-weight: 700;
          color: #168c49;
        }

        h1 {
          font-family: Georgia, serif;
          font-size: clamp(28px, 6vw, 40px);
          margin: 15px 0;
        }

        h3 {
          margin-bottom: 8px;
        }

        p {
          font-size: 15px;
          line-height: 1.7;
          color: #786354;
        }

        .details {
          background: #fff8f0;
          border: 1px solid #ffe4ca;
          padding: 20px;
          margin: 24px 0;
          border-radius: 18px;
          text-align: left;
          display: grid;
          gap: 14px;
          font-size: 14px;
        }

        .btn {
          display: block;
          width: 100%;
          padding: 16px 20px;
          border-radius: 50px;
          text-decoration: none;
          font-weight: 700;
          margin-top: 12px;
          background: #f28c28;
          color: #29190d;
          transition: .2s ease;
        }

        .whatsapp {
          background: #168c49;
          color: #fff;
        }

        .secondary {
          background: #fff;
          border: 1.5px solid #168c49;
          color: #168c49;
        }

        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 5px 20px #00000010;
        }

        .footer {
          font-size: 12px;
          margin-top: 24px;
        }

        @media (max-width: 480px) {
          .card {
            padding: 30px 20px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .card {
            animation: none;
          }

          .btn {
            transition: none;
          }
        }
      </style>
    </head>

    <body>
      <main class="card">
        ${content}
      </main>
    </body>
    </html>
  `);
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
