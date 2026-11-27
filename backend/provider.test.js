
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyWebhookMac,
  isVerifiedPaid,
} from "./provider.js";

// Test 1: Webhook security verification
test("authentic signed webhook passes, tampering fails", () => {
  const salt = "test-salt";

  const data = {
    status: "Credit",
    payment_id: "MOJO123",
    payment_request_id: "pr123",
    amount: "299.00",
  };

  const value = Object.entries(data)
    .sort(([a], [b]) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    )
    .map(([, v]) => v)
    .join("|");

  const mac = crypto
    .createHmac("sha1", salt)
    .update(value)
    .digest("hex");

  assert.equal(
    verifyWebhookMac({ ...data, mac }, salt),
    true
  );

  assert.equal(
    verifyWebhookMac({ ...data, amount: "1.00", mac }, salt),
    false
  );
});

// Test 2: Instamojo payment verification
test("verifies Instamojo v1.1 payment with processing charges", () => {
  const requestId = "abc123";
  const paymentId = "MOJO123456";

  const request = {
    success: true,
    payment_request: {
      id: requestId,
      amount: "10.00",
      status: "Completed",
    },
  };

  const payment = {
    success: true,
    payment_request: {
      id: requestId,
      payment: {
        payment_id: paymentId,
        status: "Credit",
        currency: "INR",
        amount: "13.90",
        unit_price: "10.00",
        quantity: 1,
        payment_request:
          `https://www.instamojo.com/api/1.1/payment-requests/${requestId}/`,
      },
    },
  };

  const input = {
    payment,
    request,
    requestId,
    paymentId,
    amountPaise: 1000,
  };

  // Successful payment must pass
  assert.equal(isVerifiedPaid(input), true);

  // Incorrect registration amount must fail
  assert.equal(
    isVerifiedPaid({
      ...input,
      amountPaise: 29900,
    }),
    false
  );

  // Incorrect payment ID must fail
  assert.equal(
    isVerifiedPaid({
      ...input,
      paymentId: "WRONG123",
    }),
    false
  );

  // Failed payment must not be accepted
  assert.equal(
    isVerifiedPaid({
      ...input,
      payment: {
        ...payment,
        payment_request: {
          ...payment.payment_request,
          payment: {
            ...payment.payment_request.payment,
            status: "Failed",
          },
        },
      },
    }),
    false
  );
});
