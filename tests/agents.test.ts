/**
 * Tests for the three agents.
 *
 * The contract each one must honour: propose only when the operational signal
 * warrants it, and itemize honestly — a total that does not equal the sum of its
 * own line items is refused by gate 1, so an agent that miscomputes is an agent
 * that cannot spend.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AGENTS, POLICIES, budgetAgent, renewalAgent, restockAgent } from "../src/lib/agents/index";
import { route } from "../src/lib/governor/route";
import { toMinor } from "../src/lib/governor/money";
import type { Mandate, SpendProposal } from "../src/lib/governor/types";

const NOW = new Date("2026-07-31T09:00:00Z");
const ACME = { name: "Acme Supply", url: "https://acmesupply.com", country: "US" };
const SHIPSTATION = { name: "ShipStation", url: "https://shipstation.com", country: "US" };
const GOOGLE_ADS = { name: "Google Ads", url: "https://ads.google.com", country: "US" };

/** Every proposal must survive gate 1, whatever its amount. */
function assertItemsSumToTotal(proposal: SpendProposal) {
  const items = proposal.items.reduce(
    (sum, i) => sum + toMinor(i.unit_price, proposal.currency) * i.quantity,
    0,
  );
  assert.equal(items, toMinor(proposal.total, proposal.currency), `${proposal.id} must itemize to its total`);

  const generous: Mandate[] = [{
    id: "mdt", scope: "any", merchantUrl: null, remaining: "999999.00",
    currency: "USD", validUntil: "2026-12-31T00:00:00Z", frequency: "one_time",
  }];
  const decision = route({
    proposal,
    policy: { ...POLICIES[proposal.agent], requiresGroundedPolicy: false },
    mandates: generous,
    grounding: { cited: false, citations: [] },
    now: NOW,
  });
  assert.notEqual(decision.lane, "blocked", `${proposal.id} should not be structurally invalid: ${decision.reasons.map((r) => r.detail).join("; ")}`);
}

describe("restockAgent", () => {
  const base = {
    sku: "WGT-114", description: "Widget case", distributionCenter: "DC-3",
    unitsOnHand: 40, dailyVelocity: 12, reorderPoint: 150,
    unitCost: "6.00", moq: 100, supplier: ACME,
  };

  it("stays silent when stock is above the reorder point", () => {
    assert.equal(restockAgent({ ...base, unitsOnHand: 500 }, NOW), null);
  });

  it("orders 30 days of cover when below the reorder point", () => {
    const proposal = restockAgent(base, NOW);
    assert.ok(proposal);
    assert.equal(proposal.items[0].quantity, 360, "12/day × 30 days");
    assert.equal(proposal.total, "2160.00");
    assert.equal(proposal.agent, AGENTS.restock);
    assertItemsSumToTotal(proposal);
  });

  it("respects the supplier's minimum order quantity on slow movers", () => {
    const proposal = restockAgent({ ...base, dailyVelocity: 1, moq: 100 }, NOW);
    assert.ok(proposal);
    assert.equal(proposal.items[0].quantity, 100, "30 units of demand still has to clear the 100-unit MOQ");
    assertItemsSumToTotal(proposal);
  });

  it("does not shrink the order to duck the auto-execute cap", () => {
    // 9/day × 30 = 270 units at $14 = $3,780, over the $2,500 cap. The agent
    // proposes what operations needs and lets the governor escalate.
    const proposal = restockAgent({ ...base, dailyVelocity: 9, unitCost: "14.00", unitsOnHand: 5, reorderPoint: 60 }, NOW);
    assert.ok(proposal);
    assert.equal(proposal.total, "3780.00");
    assert.ok(toMinor(proposal.total, "USD") > toMinor(POLICIES[AGENTS.restock].autoExecuteCap, "USD"));
  });

  it("reports days of cover without dividing by a zero velocity", () => {
    const proposal = restockAgent({ ...base, dailyVelocity: 0, unitsOnHand: 0 }, NOW);
    assert.ok(proposal);
    assert.match(proposal.rationale, /no measured velocity/);
    assert.equal(proposal.items[0].quantity, base.moq);
  });
});

describe("renewalAgent", () => {
  const base = {
    vendor: SHIPSTATION, plan: "Scale plan", monthlyCost: "299.00",
    renewsOn: "2026-08-03", attributedValue: "1840.00", seatsUsed: 5, seatsPaid: 7,
  };

  it("renews a tool that earns more than it costs, trimming idle seats", () => {
    const proposal = renewalAgent(base, NOW);
    assert.ok(proposal);
    assert.equal(proposal.items[0].quantity, 5, "pay for seats in use, not seats bought");
    assert.match(proposal.rationale, /Dropping 2 idle seat/);
    assertItemsSumToTotal(proposal);
  });

  it("refuses to renew a tool that costs more than it returns", () => {
    assert.equal(renewalAgent({ ...base, attributedValue: "120.00" }, NOW), null);
  });

  it("treats break-even as not worth renewing", () => {
    assert.equal(renewalAgent({ ...base, attributedValue: "299.00" }, NOW), null);
  });

  it("bills at least one seat even when usage reads as zero", () => {
    const proposal = renewalAgent({ ...base, seatsUsed: 0 }, NOW);
    assert.ok(proposal);
    assert.equal(proposal.items[0].quantity, 1);
    assertItemsSumToTotal(proposal);
  });
});

describe("budgetAgent", () => {
  const base = {
    channel: GOOGLE_ADS, campaign: "Brand — Search", balance: "180.00",
    dailySpend: "95.00", roas: 3.4, targetRoas: 2.0,
  };

  it("tops up a converting channel that is about to run dry", () => {
    const proposal = budgetAgent(base, NOW);
    assert.ok(proposal);
    assert.equal(proposal.items[0].quantity, 7, "seven days of runway");
    assert.equal(proposal.total, "665.00");
    assertItemsSumToTotal(proposal);
  });

  it("does not fund a channel below target ROAS, however low the balance", () => {
    assert.equal(budgetAgent({ ...base, roas: 1.1 }, NOW), null);
  });

  it("waits while there is still runway", () => {
    assert.equal(budgetAgent({ ...base, balance: "2000.00" }, NOW), null);
  });

  it("does not divide by a zero daily spend", () => {
    assert.equal(budgetAgent({ ...base, dailySpend: "0.00" }, NOW), null);
  });
});

describe("agent policies", () => {
  it("gives every agent a policy, and every procurement agent a grounding requirement", () => {
    for (const agent of Object.values(AGENTS)) {
      const policy = POLICIES[agent];
      assert.ok(policy, `${agent} must have a policy`);
      assert.equal(policy.agent, agent);
      assert.ok(toMinor(policy.autoExecuteCap, policy.currency) > 0, `${agent} needs a positive cap`);
    }
    assert.equal(POLICIES[AGENTS.restock].requiresGroundedPolicy, true, "supplier spend must be citable");
    assert.equal(POLICIES[AGENTS.renewal].requiresGroundedPolicy, true, "vendor renewals must be citable");
  });

  it("scopes every grounded agent to an explicit merchant allowlist", () => {
    for (const policy of Object.values(POLICIES)) {
      if (policy.requiresGroundedPolicy) {
        assert.notEqual(policy.allowedMerchants, "any", `${policy.agent} must not spend anywhere`);
      }
    }
  });
});
