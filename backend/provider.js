import crypto from "node:crypto";

// Instamojo API v1.1 — Private API Key + Private Auth Token
export function makeInstamojo({ baseUrl, apiKey, authToken, fetcher = fetch }) {
  const origin = new URL(baseUrl);

  if (
    origin.protocol !== "https:" ||
    !["test.instamojo.com", "www.instamojo.com"].includes(origin.hostname)
  ) {
    throw new Error("Unsupported Instamojo API origin");
  }

  if (!apiKey || !authToken) {
    throw new Error("Missing Instamojo API v1.1 credentials");
  }

  async function request(path, options = {}) {
    const response = await fetcher(origin.origin + path, {
      ...options,
      headers: {
        Accept: "application/json",
        "X-Api-Key": apiKey,
        "X-Auth-Token": authToken,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || data?.success === false) {
      const reason =
        data?.message || data?.error || data?.errors || "No details returned";

      console.error("Instamojo rejected payment request:", {
        status: response.status,
        reason,
      });

      throw new Error(`Instamojo request failed: HTTP ${response.status}`);
    }

    return data;
  }

  return {
    async createPayment({
      registrationId,
      name,
      phone,
      email,
      amountRupees,
      redirectUrl,
      webhookUrl,
    }) {
      const form = new URLSearchParams({
        purpose: "Shilpakar - 15 Days Water Challenge",
        amount: amountRupees.toFixed(2),
        buyer_name: name,
        phone,
        email,
        redirect_url: redirectUrl,
        allow_repeated_payments: "False",
        send_email: "False",
        send_sms: "False",
      });

      if (webhookUrl) {
        form.set("webhook", webhookUrl);
      }

      const result = await request("/api/1.1/payment-requests/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });

      const payment = result?.payment_request;

      if (!payment?.id || !payment?.longurl) {
        throw new Error("Invalid Instamojo payment response");
      }

      const checkout = new URL(payment.longurl);

      if (
        checkout.protocol !== "https:" ||
        !["test.instamojo.com", "www.instamojo.com", "instamojo.com"].includes(
          checkout.hostname,
        )
      ) {
        throw new Error("Invalid Instamojo checkout URL");
      }

      if (
        origin.hostname === "test.instamojo.com" &&
        checkout.hostname !== "test.instamojo.com"
      ) {
        throw new Error("Sandbox returned a live checkout");
      }

      checkout.searchParams.set("embed", "form");

      return {
        id: String(payment.id),
        url: checkout.toString(),
      };
    },

    getRequest(id) {
      return request(`/api/1.1/payment-requests/${encodeURIComponent(id)}/`);
    },

    getPayment(paymentId, requestId) {
      return request(
        `/api/1.1/payment-requests/${encodeURIComponent(requestId)}/${encodeURIComponent(paymentId)}/`,
      );
    },
  };
}

export function verifyWebhookMac(body, salt) {
  if (
    !salt ||
    !body ||
    typeof body.mac !== "string" ||
    !/^[a-f\d]{40}$/i.test(body.mac)
  ) {
    return false;
  }

  const entries = Object.entries(body)
    .filter(([key]) => key.toLowerCase() !== "mac")
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const expected = crypto
    .createHmac("sha1", salt)
    .update(entries.map(([, value]) => String(value)).join("|"))
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(body.mac, "hex"),
  );
}

export const normalizeRequest = (r) => r?.payment_request || r;
export const normalizePayment = (p) => p?.payment || p;

export function paymentBelongsToRequest(payment, requestId) {
  const ref = payment?.payment_request;

  if (typeof ref === "string") {
    return ref.replace(/\/$/, "").split("/").at(-1) === requestId;
  }

  if (ref && typeof ref === "object") {
    return String(ref.id || "") === requestId;
  }

  return false;
}

export function isVerifiedPaid({
  payment,
  request,
  requestId,
  paymentId,
  amountPaise,
}) {
  const r = normalizeRequest(request);
  const paymentRequest = payment?.payment_request;
  const p = paymentRequest?.payment;

  if (payment?.success !== true || request?.success !== true || !p || !r) {
    return false;
  }

  const expectedAmount = Number(amountPaise);
  const requestAmount = Math.round(Number(r.amount) * 100);
  const unitPrice = Math.round(Number(p.unit_price) * 100);
  const totalPaid = Math.round(Number(p.amount) * 100);

  const verified =
    p.status === "Credit" &&
    p.currency === "INR" &&
    String(r.id || "") === requestId &&
    String(paymentRequest.id || "") === requestId &&
    String(p.payment_id || "") === paymentId &&
    paymentBelongsToRequest(p, requestId) &&
    Number(p.quantity) === 1 &&
    Number.isSafeInteger(expectedAmount) &&
    expectedAmount > 0 &&
    requestAmount === expectedAmount &&
    unitPrice === expectedAmount &&
    Number.isSafeInteger(totalPaid) &&
    totalPaid >= expectedAmount;

  console.log("PAYMENT VERIFICATION RESULT:", {
    status: p.status,
    requestAmount,
    unitPrice,
    totalPaid,
    expectedAmount,
    verified,
  });

  return verified;
}
