/**
 * Tests for the execution path and the ledger's state machine.
 *
 * These cover the invariants `route()` cannot enforce on its own: that evidence
 * exists before money moves, that every successful charge gets reported back to
 * the network, and that a settlement can only happen once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { propose, settleApproved, type GovernorDeps } from "../src/lib/governor/execute";
import type { AgentPolicy, Mandate, SpendProposal } from "../src/lib/governor/types";
import { SandboxPrava } from "../src/lib/prava/sandbox";
import { FixtureGroundingSource, type GroundingSource } from "../src/lib/senso/client";
import { Ledger } from "../src/lib/store/ledger";

const NOW = new Date("2026-07-31T09:00:00Z");
const WEEK_OUT = "2026-08-07T09:00:00Z";
const ACME = { name: "Acme Supply", url: "https://acmesupply.com", country: "US" };

const POLICY: AgentPolicy = {
  agent: "Restock Agent",
  autoExecuteCap: "2500.00",
  currency: "USD",
  allowedMerchants: ["acmesupply.com"],
  requiresGroundedPolicy: true,
};

const GROUNDED = new FixtureGroundingSource([{
  agent: "Restock Agent",
  merchantHost: "acmesupply.com",
  maxMinor: 1_000_000,
  source: "Procurement Policy v4 §3.2",
  excerpt: "Replenishment orders with approved suppliers may be issued automatically up to $10,000.",
}]);

/** Grounding source that always fails, to check the outage behaviour. */
const BROKEN: GroundingSource = { ground: () => Promise.reject(new Error("senso unreachable")) };

function proposal(over: Partial<SpendProposal> = {}): SpendProposal {
  return {
    id: "prop_exec_1",
    agent: "Restock Agent",
    kind: "purchase",
    merchant: ACME,
    total: "600.00",
    currency: "USD",
    items: [{ description: "Widget case", unit_price: "6.00", quantity: 100 }],
    rationale: "Below reorder point at DC-3.",
    ...over,
  };
}

function mandates(remaining = "8000.00"): Mandate[] {
  return [{
    id: "mdt_acme", scope: "listed", merchantUrl: "https://acmesupply.com",
    remaining, currency: "USD", validUntil: WEEK_OUT, frequency: "one_time",
  }];
}

function harness(options: {
  mandates?: Mandate[];
  grounding?: GroundingSource;
  declineAll?: boolean;
  throwOnCharge?: boolean;
} = {}) {
  const prava = new SandboxPrava({
    mandates: options.mandates ?? mandates(),
    declineAll: options.declineAll,
    throwOnCharge: options.throwOnCharge,
  });
  const ledger = new Ledger();
  const deps: GovernorDeps = {
    prava,
    grounding: options.grounding ?? GROUNDED,
    ledger,
    clock: () => NOW,
  };
  return { prava, ledger, deps };
}

describe("propose — the auto lane moves money", () => {
  it("charges the mandate, settles the ledger, and reports to the network", async () => {
    const { prava, deps } = harness();
    const result = await propose(proposal(), POLICY, deps);

    assert.equal(result.packet.lane, "auto");
    assert.equal(result.packet.settlement, "settled");
    assert.ok(result.credential, "a successful charge should return a credential");
    assert.equal(result.packet.txnId, result.credential!.txnId);
    assert.deepEqual(prava.unreportedCharges(), [], "every charge must be reported back to the network");
    assert.equal(prava.remainingOf("mdt_acme"), "7400.00", "the mandate should be drawn down by the charge");
  });

  it("writes the evidence packet with the citation that authorized the spend", async () => {
    const { deps } = harness();
    const { packet } = await propose(proposal(), POLICY, deps);
    assert.equal(packet.citations.length, 1);
    assert.match(packet.citations[0].source, /Procurement Policy/);
  });

  it("records a network decline without moving money or losing the audit row", async () => {
    const { prava, deps } = harness({ declineAll: true });
    const result = await propose(proposal(), POLICY, deps);

    assert.equal(result.packet.lane, "auto", "the decision stands even though the network refused");
    assert.equal(result.packet.settlement, "declined");
    assert.equal(result.credential, null);
    assert.equal(prava.remainingOf("mdt_acme"), "8000.00", "a declined charge must not draw down the mandate");
  });

  it("records a transport failure as failed rather than throwing", async () => {
    const { deps } = harness({ throwOnCharge: true });
    const result = await propose(proposal(), POLICY, deps);
    assert.equal(result.packet.settlement, "failed");
    assert.equal(result.credential, null);
  });
});

describe("propose — refusals are still auditable", () => {
  it("refuses when grounding is unavailable, and records the attempted amount", async () => {
    const { prava, deps } = harness({ grounding: BROKEN });
    const { packet } = await propose(proposal(), POLICY, deps);

    assert.equal(packet.lane, "blocked", "a grounding outage must stop spending, not permit it");
    assert.equal(packet.settlement, "refused");
    assert.equal(packet.totalMinor, 60_000, "the refused amount belongs in the audit record");
    assert.equal(prava.remainingOf("mdt_acme"), "8000.00");
  });

  it("queues an over-cap spend for a human without charging anything", async () => {
    const { prava, deps } = harness();
    const big = proposal({
      id: "prop_big",
      total: "3780.00",
      items: [{ description: "Pallet", unit_price: "14.00", quantity: 270 }],
    });
    const { packet } = await propose(big, POLICY, deps);

    assert.equal(packet.lane, "approval");
    assert.equal(packet.settlement, "awaiting_approval");
    assert.equal(packet.mandateId, "mdt_acme", "the mandate is retained so an approver's yes can settle against it");
    assert.equal(prava.remainingOf("mdt_acme"), "8000.00", "nothing moves before a human says yes");
  });
});

describe("settleApproved — the human gate", () => {
  it("charges the mandate once a person approves", async () => {
    const { prava, ledger, deps } = harness();
    const big = proposal({ id: "prop_big", total: "3780.00", items: [{ description: "Pallet", unit_price: "14.00", quantity: 270 }] });
    await propose(big, POLICY, deps);

    const settled = await settleApproved(big, deps, "sarah.chen@ops.io");
    assert.equal(settled.packet.settlement, "settled");
    assert.equal(settled.packet.approvedBy, "sarah.chen@ops.io");
    assert.equal(prava.remainingOf("mdt_acme"), "4220.00");
    assert.deepEqual(prava.unreportedCharges(), []);
    assert.equal(ledger.list({ lane: "approval" })[0].settlement, "settled");
  });

  it("mints a passkey session when no mandate covers the spend", async () => {
    const { prava, deps } = harness({ mandates: [] });
    const p = proposal({ id: "prop_no_mandate" });
    const queued = await propose(p, POLICY, deps);
    assert.equal(queued.packet.lane, "approval");
    assert.equal(queued.packet.mandateId, null);
    assert.equal(prava.sessions.length, 0, "a session must not be minted before the human decision");

    const settled = await settleApproved(p, deps, "sarah.chen@ops.io");
    assert.equal(prava.sessions.length, 1, "the session is minted only after approval");
    assert.equal(settled.packet.settlement, "settled");
    assert.match(settled.paymentUrl ?? "", /^https:\/\/pay\.prava\.space\//);
  });

  it("refuses to settle the same proposal twice", async () => {
    const { deps } = harness();
    const big = proposal({ id: "prop_twice", total: "3780.00", items: [{ description: "Pallet", unit_price: "14.00", quantity: 270 }] });
    await propose(big, POLICY, deps);
    await settleApproved(big, deps, "sarah.chen@ops.io");

    await assert.rejects(
      () => settleApproved(big, deps, "sarah.chen@ops.io"),
      /is settled, not awaiting approval/,
    );
  });

  it("refuses to settle a proposal that was never routed", async () => {
    const { deps } = harness();
    await assert.rejects(() => settleApproved(proposal({ id: "ghost" }), deps, "x@y.io"), /no decision on record/);
  });

  it("refuses to settle a blocked proposal", async () => {
    const { deps } = harness({ grounding: BROKEN });
    const p = proposal({ id: "prop_blocked" });
    await propose(p, POLICY, deps);
    await assert.rejects(() => settleApproved(p, deps, "x@y.io"), /is refused, not awaiting approval/);
  });
});

describe("ledger", () => {
  it("is idempotent on proposal id, so a retried route cannot double-authorize", async () => {
    const { prava, ledger, deps } = harness();
    await propose(proposal(), POLICY, deps);
    await propose(proposal(), POLICY, deps);

    assert.equal(ledger.list({ limit: 100 }).length, 1, "one proposal id, one evidence row");
    assert.equal(prava.remainingOf("mdt_acme"), "7400.00", "the second attempt must not charge again");
  });

  it("treats a duplicate settlement as a no-op", () => {
    const ledger = new Ledger();
    const p = proposal({ id: "prop_settle_once" });
    ledger.recordDecision({
      proposal: p,
      decision: { proposalId: p.id, lane: "auto", reasons: [], mandateId: "mdt_acme", totalMinor: 60_000, currency: "USD" },
      grounding: { cited: true, citations: [{ source: "s", excerpt: "e" }] },
      decidedAt: NOW,
    });

    assert.equal(ledger.settle({ proposalId: p.id, settlement: "settled", txnId: "txn_1", settledAt: NOW }), true);
    assert.equal(ledger.settle({ proposalId: p.id, settlement: "declined", txnId: "txn_2", settledAt: NOW }), false);
    assert.equal(ledger.get(p.id)!.settlement, "settled", "the first outcome stands");
    assert.equal(ledger.get(p.id)!.txnId, "txn_1");
    ledger.close();
  });

  it("totals only what actually settled", async () => {
    const { ledger, deps } = harness({ mandates: mandates("100000.00") });
    await propose(proposal({ id: "a" }), POLICY, deps);
    await propose(proposal({ id: "b", total: "300.00", items: [{ description: "Widget case", unit_price: "6.00", quantity: 50 }] }), POLICY, deps);
    // Refused — must not count toward the total.
    await propose(
      proposal({ id: "c", merchant: { name: "Grey", url: "https://grey.example", country: "US" } }),
      POLICY,
      deps,
    );

    assert.deepEqual(ledger.settledTotals(), [{ currency: "USD", totalMinor: 90_000, charges: 2 }]);
  });
});
