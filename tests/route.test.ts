/**
 * Characterization tests for the spend-routing engine.
 *
 * These pin the money math and the gate order. A change that moves a proposal
 * from `blocked` or `approval` into `auto` must break a test here first — that
 * is the whole point of the file.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { route } from "../src/lib/governor/route";
import { toMinor, toDecimal } from "../src/lib/governor/money";
import type { AgentPolicy, Grounding, Mandate, RouteInput, SpendProposal } from "../src/lib/governor/types";

const NOW = new Date("2026-07-31T12:00:00Z");
const LATER = "2026-08-05T12:00:00Z";
const EARLIER = "2026-07-30T12:00:00Z";

const grounded: Grounding = {
  cited: true,
  citations: [{ source: "Procurement Policy v4", excerpt: "Reorders below $10,000 may be issued automatically." }],
};

const ungrounded: Grounding = { cited: false, citations: [] };

function proposal(over: Partial<SpendProposal> = {}): SpendProposal {
  return {
    id: "prop_1",
    agent: "Restock Agent",
    kind: "purchase",
    merchant: { name: "Acme Supply", url: "https://acmesupply.com", country: "US" },
    total: "120.00",
    currency: "USD",
    items: [{ description: "Widget case", unit_price: "60.00", quantity: 2 }],
    rationale: "Stockout risk at DC-3 in 6 days.",
    ...over,
  };
}

function policy(over: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    agent: "Restock Agent",
    autoExecuteCap: "500.00",
    currency: "USD",
    allowedMerchants: ["acmesupply.com"],
    requiresGroundedPolicy: true,
    ...over,
  };
}

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "mdt_listed",
    scope: "listed",
    merchantUrl: "https://acmesupply.com",
    remaining: "1000.00",
    currency: "USD",
    validUntil: LATER,
    frequency: "one_time",
    ...over,
  };
}

function input(over: Partial<RouteInput> = {}): RouteInput {
  return {
    proposal: proposal(),
    policy: policy(),
    mandates: [mandate()],
    grounding: grounded,
    now: NOW,
    ...over,
  };
}

const codes = (d: ReturnType<typeof route>) => d.reasons.map((r) => r.code);

describe("money", () => {
  it("round-trips two-decimal strings through minor units", () => {
    for (const value of ["0.01", "8.50", "120.00", "9999.99"]) {
      assert.equal(toDecimal(toMinor(value, "USD")), value);
    }
  });

  it("does not lose a cent on values that break float math", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; integer cents make it exact.
    assert.equal(toMinor("0.10", "USD") + toMinor("0.20", "USD"), toMinor("0.30", "USD"));
  });

  it("refuses currencies whose exponent is not 2 rather than mis-scaling them", () => {
    assert.throws(() => toMinor("1000", "JPY"), /not a two-decimal currency/);
    assert.throws(() => toMinor("1.000", "KWD"), /not a two-decimal currency/);
  });

  it("refuses malformed amounts", () => {
    for (const bad of ["8.5.0", "-1.00", "8.501", "", "1e3", "8,50"]) {
      assert.throws(() => toMinor(bad, "USD"), /amount must be/, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });
});

describe("route — the auto lane", () => {
  it("routes a grounded, in-cap, mandate-covered spend to auto", () => {
    const decision = route(input());
    assert.equal(decision.lane, "auto");
    assert.equal(decision.mandateId, "mdt_listed");
    assert.equal(decision.totalMinor, 12_000);
    assert.deepEqual(codes(decision), ["mandate_covers_spend", "within_agent_cap"]);
  });

  it("treats a spend exactly at the cap as within it", () => {
    const decision = route(input({
      proposal: proposal({ total: "500.00", items: [{ description: "Pallet", unit_price: "500.00", quantity: 1 }] }),
    }));
    assert.equal(decision.lane, "auto");
  });

  it("prefers a merchant-specific mandate over a generic budget", () => {
    const decision = route(input({
      mandates: [
        mandate({ id: "mdt_any", scope: "any", merchantUrl: null }),
        mandate({ id: "mdt_listed" }),
      ],
    }));
    assert.equal(decision.lane, "auto");
    assert.equal(decision.mandateId, "mdt_listed", "a narrow authorization should be spent before a broad one");
  });

  it("accepts a subdomain of an allowlisted host but not a lookalike suffix", () => {
    const onSubdomain = route(input({
      proposal: proposal({ merchant: { name: "Acme", url: "https://shop.acmesupply.com", country: "US" } }),
      mandates: [mandate({ merchantUrl: "https://acmesupply.com" })],
    }));
    assert.equal(onSubdomain.lane, "auto");

    const lookalike = route(input({
      proposal: proposal({ merchant: { name: "Not Acme", url: "https://evil-acmesupply.com", country: "US" } }),
    }));
    assert.equal(lookalike.lane, "blocked");
    assert.deepEqual(codes(lookalike), ["merchant_not_allowed"]);
  });
});

describe("route — the approval lane", () => {
  it("escalates a spend over the agent's cap even when a mandate covers it", () => {
    const decision = route(input({
      proposal: proposal({ total: "750.00", items: [{ description: "Pallet", unit_price: "750.00", quantity: 1 }] }),
    }));
    assert.equal(decision.lane, "approval");
    assert.equal(decision.mandateId, "mdt_listed", "an approver's yes can still settle against the mandate");
    assert.ok(codes(decision).includes("over_agent_cap"));
  });

  it("escalates rather than refuses when no mandate matches — a passkey session is the path", () => {
    const decision = route(input({ mandates: [] }));
    assert.equal(decision.lane, "approval");
    assert.equal(decision.mandateId, null);
    assert.deepEqual(codes(decision), ["no_mandate_match"]);
  });

  it("escalates when every matching mandate has expired", () => {
    const decision = route(input({ mandates: [mandate({ validUntil: EARLIER })] }));
    assert.equal(decision.lane, "approval");
    assert.deepEqual(codes(decision), ["mandate_expired"]);
  });

  it("escalates when the charge exceeds the remaining balance", () => {
    const decision = route(input({ mandates: [mandate({ remaining: "50.00" })] }));
    assert.equal(decision.lane, "approval");
    assert.deepEqual(codes(decision), ["mandate_insufficient_remaining"]);
  });

  it("treats an unparseable remaining balance as zero, never as unlimited", () => {
    const decision = route(input({ mandates: [mandate({ remaining: "unlimited" })] }));
    assert.equal(decision.lane, "approval");
    assert.deepEqual(codes(decision), ["mandate_insufficient_remaining"]);
  });

  it("treats an unparseable expiry as expired, never as live", () => {
    const decision = route(input({ mandates: [mandate({ validUntil: "whenever" })] }));
    assert.equal(decision.lane, "approval");
    assert.deepEqual(codes(decision), ["mandate_expired"]);
  });
});

describe("route — the blocked lane", () => {
  it("refuses a total that does not equal the sum of its line items", () => {
    const decision = route(input({
      proposal: proposal({
        total: "120.00",
        items: [{ description: "Widget case", unit_price: "60.00", quantity: 1 }],
      }),
    }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["invalid_amount"]);
    assert.match(decision.reasons[0].detail, /does not equal the sum of line items/);
  });

  it("refuses a zero-value spend", () => {
    const decision = route(input({
      proposal: proposal({ total: "0.00", items: [{ description: "Free sample", unit_price: "0.00", quantity: 1 }] }),
    }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["invalid_amount"]);
  });

  it("refuses a fractional quantity that would silently truncate", () => {
    const decision = route(input({
      proposal: proposal({ total: "60.00", items: [{ description: "Widget", unit_price: "60.00", quantity: 1.5 }] }),
    }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["invalid_amount"]);
  });

  it("refuses when the policy cap and the proposal are in different currencies", () => {
    const decision = route(input({ policy: policy({ currency: "EUR" }) }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["currency_mismatch"]);
  });

  it("refuses an off-allowlist merchant", () => {
    const decision = route(input({
      proposal: proposal({ merchant: { name: "Random", url: "https://random-store.example", country: "US" } }),
    }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["merchant_not_allowed"]);
  });

  it("refuses an ungrounded spend when the agent requires a policy citation", () => {
    const decision = route(input({ grounding: ungrounded }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["policy_not_grounded"]);
  });

  it("refuses a grounding claim that carries no citations", () => {
    const decision = route(input({ grounding: { cited: true, citations: [] } }));
    assert.equal(decision.lane, "blocked");
    assert.deepEqual(codes(decision), ["policy_not_grounded"]);
  });

  it("allows an ungrounded spend only for agents that do not require grounding", () => {
    const decision = route(input({
      grounding: ungrounded,
      policy: policy({ requiresGroundedPolicy: false }),
    }));
    assert.equal(decision.lane, "auto");
  });

  it("refuses before consulting mandates — a bad amount never reaches the cap check", () => {
    const decision = route(input({
      proposal: proposal({ total: "9.999", items: [{ description: "x", unit_price: "9.999", quantity: 1 }] }),
      mandates: [mandate({ remaining: "100000.00" })],
    }));
    assert.equal(decision.lane, "blocked");
    assert.equal(decision.mandateId, null);
  });
});
