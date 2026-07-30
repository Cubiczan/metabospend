/**
 * Tests for the REST gateway.
 *
 * `fetch` is stubbed, so these run offline. They cover the parts most likely to
 * quietly go wrong against a real API: the key/environment guard, which mandates
 * are considered spendable, and the merchant-URL resolution that our hostname
 * matching depends on.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { PravaError } from "../src/lib/prava/client";
import {
  InMemoryMerchantRegistry,
  LIVE_BASE_URL,
  PravaRestClient,
  SANDBOX_BASE_URL,
} from "../src/lib/prava/rest";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

/** Stub fetch with a queue of responses, capturing what was sent. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const next = responses[Math.min(index++, responses.length - 1)];
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function client(overrides: Partial<ConstructorParameters<typeof PravaRestClient>[0]> = {}) {
  return new PravaRestClient({
    secretKey: "sk_test_abc123",
    baseUrl: SANDBOX_BASE_URL,
    customer: { id: "cus_test", email: "ops@example.com" },
    ...overrides,
  });
}

describe("environment guards", () => {
  it("refuses to start with no secret key", () => {
    assert.throws(() => new PravaRestClient({ secretKey: "" }), (error: unknown) => {
      assert.ok(error instanceof PravaError);
      assert.equal(error.code, "NO_KEY");
      return true;
    });
  });

  it("refuses a live key pointed at the sandbox URL", () => {
    // This is the mix-up that would move real money while everyone believed
    // they were testing, so it is refused rather than resolved.
    assert.throws(
      () => new PravaRestClient({ secretKey: "sk_live_real", baseUrl: SANDBOX_BASE_URL }),
      /live secret key was given with the sandbox base URL/,
    );
  });

  it("refuses a test key pointed at the live URL", () => {
    assert.throws(
      () => new PravaRestClient({ secretKey: "sk_test_abc", baseUrl: LIVE_BASE_URL }),
      /test secret key cannot be used against the live API/,
    );
  });

  it("reports sandbox mode so callers can label their output", () => {
    assert.equal(client().isSandbox, true);
    assert.equal(new PravaRestClient({ secretKey: "sk_live_x", baseUrl: LIVE_BASE_URL }).isSandbox, false);
  });
});

describe("listMandates", () => {
  const active = {
    id: "mdt_1", status: "active", state: "available", merchantScope: "listed",
    merchantName: "Acme Supply", remaining: "8000.00", currency: "usd",
    validUntil: "2026-08-07T09:00:00Z", recurringFrequency: "one_time",
  };

  it("authenticates with the secret key as a bearer token", async () => {
    const calls = stubFetch([{ body: { mandates: [] } }]);
    await client().listMandates();
    assert.equal(calls[0].headers.Authorization, "Bearer sk_test_abc123");
    assert.match(calls[0].url, /^https:\/\/sandbox\.api\.prava\.space\/v1\/mandates\?/);
  });

  it("resolves a listed mandate's merchant URL from the registry", async () => {
    const registry = new InMemoryMerchantRegistry();
    registry.remember("mdt_1", "https://acmesupply.com");
    stubFetch([{ body: { mandates: [active] } }]);

    const [mandate] = await client({ registry }).listMandates();
    assert.equal(mandate.merchantUrl, "https://acmesupply.com");
    assert.equal(mandate.currency, "USD", "currency should be upper-cased");
  });

  it("leaves merchantUrl null when the registry has no record, so it matches nothing", async () => {
    // The API returns only merchantName, and a display name is far too weak to
    // authorize a payment against.
    stubFetch([{ body: { mandates: [active] } }]);
    const [mandate] = await client().listMandates();
    assert.equal(mandate.merchantUrl, null);
  });

  it("excludes mandates that are not active and available", async () => {
    stubFetch([{ body: { mandates: [
      { ...active, id: "mdt_pending", status: "pending" },
      { ...active, id: "mdt_paused", status: "paused" },
      { ...active, id: "mdt_cancelled", status: "cancelled" },
      { ...active, id: "mdt_consumed", status: "active", state: "consumed" },
      { ...active, id: "mdt_expired", status: "active", state: "expired" },
      { ...active, id: "mdt_ok" },
    ] } }]);

    const ids = (await client().listMandates()).map((m) => m.id);
    assert.deepEqual(ids, ["mdt_ok"], "only an active, available mandate is spendable");
  });

  it("falls back to approvedAmount when remaining is absent", async () => {
    stubFetch([{ body: { mandates: [{ ...active, remaining: undefined, approvedAmount: "250.00" }] } }]);
    const [mandate] = await client().listMandates();
    assert.equal(mandate.remaining, "250.00");
  });
});

describe("chargeMandate", () => {
  it("returns a credential on success and carries the transaction id", async () => {
    const calls = stubFetch([{ body: {
      mandateId: "mdt_1", transactionId: "txn_9", status: "awaiting_result", fetchStatus: "SUCCESS",
      credentials: { token: "4323126882557932", dynamicCvv: "957", expiryMonth: "12", expiryYear: "2027" },
    } }]);

    const result = await client().chargeMandate({ mandateId: "mdt_1", amount: "120.00", reference: "prop_1" });
    assert.ok(result.ok);
    assert.equal(result.credential.txnId, "txn_9");
    assert.equal(result.credential.cryptogram, "957");
    assert.deepEqual(calls[0].body, { amount: "120.00", reference: "prop_1" });
    assert.match(calls[0].url, /\/v1\/mandates\/mdt_1\/charge$/);
  });

  it("reads a failed status as a decline rather than throwing", async () => {
    stubFetch([{ status: 402, body: { status: "failed", errorCode: "THRESHOLD_EXCEEDED", errorMessage: "over cap" } }]);
    const result = await client().chargeMandate({ mandateId: "mdt_1", amount: "9999.00" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.declineCode, "THRESHOLD_EXCEEDED");
  });

  it("treats a success status with no credentials as a decline, not a silent pass", async () => {
    stubFetch([{ body: { mandateId: "mdt_1", transactionId: "txn_9", status: "awaiting_result" } }]);
    const result = await client().chargeMandate({ mandateId: "mdt_1", amount: "10.00" });
    assert.equal(result.ok, false);
  });

  it("throws on an unexpected HTTP error rather than reporting a decline", async () => {
    // A 500 is not a decline — treating it as one would mask an outage as a
    // legitimate refusal.
    stubFetch([{ status: 500, body: { message: "internal error" } }]);
    await assert.rejects(() => client().chargeMandate({ mandateId: "mdt_1", amount: "10.00" }), /HTTP_500|500/);
  });
});

describe("reportMandateCharge", () => {
  it("posts to the nested charge report path with a purchase type", async () => {
    const calls = stubFetch([{ body: { settled: true } }]);
    await client().reportMandateCharge({ mandateId: "mdt_1", txnId: "txn_9", status: "APPROVED" });
    assert.match(calls[0].url, /\/v1\/mandates\/mdt_1\/charges\/txn_9\/report$/);
    assert.deepEqual(calls[0].body, { status: "APPROVED", type: "PURCHASE" });
  });
});

describe("createMandate", () => {
  it("sends listed scope with merchant details and remembers the URL", async () => {
    const registry = new InMemoryMerchantRegistry();
    const calls = stubFetch([{ body: { id: "mdt_new", status: "pending", approval_url: "https://pay.prava.space/approve/x" } }]);

    const c = client({ registry });
    const result = await c.createMandate({
      amount: "500.00", currency: "USD",
      merchant: { name: "Acme Supply", url: "https://acmesupply.com", country: "US" },
    });

    assert.equal(result.mandateId, "mdt_new");
    assert.equal(result.approvalUrl, "https://pay.prava.space/approve/x");
    assert.equal(registry.urlFor("mdt_new"), "https://acmesupply.com", "the URL must be captured at creation — the list endpoint won't return it");
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.merchant_scope, "listed");
    assert.equal(body.merchant_url, "https://acmesupply.com");
  });

  it("sends any scope with no merchant details for a generic budget", async () => {
    const calls = stubFetch([{ body: { id: "mdt_any", status: "pending" } }]);
    await client().createMandate({ amount: "300.00", currency: "USD" });
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.merchant_scope, "any");
    assert.equal(body.merchant_url, undefined);
  });

  it("ignores a non-URL approval value rather than presenting it as a link", async () => {
    stubFetch([{ body: { id: "mdt_x", status: "pending", approval_url: "pending" } }]);
    const result = await client().createMandate({ amount: "10.00", currency: "USD" });
    assert.equal(result.approvalUrl, null);
  });
});

describe("pollSession", () => {
  it("returns the credential once the session completes", async () => {
    stubFetch([
      { body: { status: "pending", transactions: [] } },
      { body: { status: "completed", transactions: [{ txn_id: "txn_s", token: "4323126882557932", dynamic_cvv: "111", expiry_month: "12", expiry_year: "2027" }] } },
    ]);
    const credential = await client().pollSession("sess_1", { attempts: 5, intervalMs: 1 });
    assert.equal(credential.txnId, "txn_s");
  });

  it("throws with the merchant's message when the session fails", async () => {
    stubFetch([{ body: { status: "failed", transactions: [{ error: { message: "insufficient funds" } }] } }]);
    await assert.rejects(() => client().pollSession("sess_1", { attempts: 3, intervalMs: 1 }), /insufficient funds/);
  });

  it("times out rather than polling forever", async () => {
    stubFetch([{ body: { status: "pending", transactions: [] } }]);
    await assert.rejects(() => client().pollSession("sess_1", { attempts: 2, intervalMs: 1 }), /did not complete within the polling window/);
  });
});
