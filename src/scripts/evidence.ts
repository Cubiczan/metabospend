/**
 * Print one full evidence packet.
 *
 *   npm run evidence
 *
 * The packet is the artifact the whole product exists to produce — the answer to
 * "who authorized this spend, and what would have stopped it?" Everything else is
 * machinery for generating it honestly.
 *
 * Prints one settled charge and one refusal, because the refusal is the half
 * people forget: a spend that never happened still has to be auditable.
 */
import { AGENTS, POLICIES, restockAgent } from "../lib/agents/index";
import { propose, type GovernorDeps } from "../lib/governor/execute";
import { format } from "../lib/governor/money";
import type { Mandate } from "../lib/governor/types";
import { SandboxPrava } from "../lib/prava/sandbox";
import { FixtureGroundingSource } from "../lib/senso/client";
import { Ledger, type EvidencePacket } from "../lib/store/ledger";

const NOW = new Date("2026-08-01T09:00:00Z");

const ACME = { name: "Acme Supply", url: "https://acmesupply.com", country: "US" };
const NORTHPORT = { name: "Northport Packaging", url: "https://northportpackaging.com", country: "US" };

const MANDATES: Mandate[] = [{
  id: "mdt_acme", scope: "listed", merchantUrl: "https://acmesupply.com",
  remaining: "8000.00", currency: "USD", validUntil: "2026-08-08T09:00:00Z", frequency: "one_time",
}];

const POLICY_CORPUS = new FixtureGroundingSource([{
  agent: AGENTS.restock,
  merchantHost: "acmesupply.com",
  maxMinor: 1_000_000,
  source: "Procurement Policy v4 §3.2",
  excerpt: "Replenishment orders with approved suppliers may be issued by automated systems up to $10,000 per order.",
}]);

function render(packet: EvidencePacket, heading: string) {
  // An empty key indents a continuation line rather than printing a bare colon.
  const line = (k: string, v: string) => console.log(`  ${(k ? `${k}:` : "").padEnd(16)} ${v}`);
  console.log(`\n${"─".repeat(96)}`);
  console.log(`  ${heading}`);
  console.log("─".repeat(96));
  line("proposal", packet.proposalId);
  line("agent", packet.agent);
  line("lane", packet.lane.toUpperCase());
  line("amount", format(packet.totalMinor, packet.currency));
  line("merchant", `${packet.merchantName}  ${packet.merchantUrl}`);
  line("rationale", packet.rationale);
  line("gates", packet.reasonCodes.join(" → "));
  line("reasoning", packet.reasonDetail);
  if (packet.citations.length > 0) {
    for (const c of packet.citations) {
      line("authorized by", c.source);
      line("", `"${c.excerpt}"`);
    }
  } else {
    line("authorized by", "— nothing. No published policy covers this spend.");
  }
  line("mandate", packet.mandateId ?? "— none drawn on");
  line("transaction", packet.txnId ?? "— no money moved");
  line("settlement", packet.settlement);
  line("decided at", packet.decidedAt);
  line("settled at", packet.settledAt ?? "—");
  line("approved by", packet.approvedBy ?? "— no human involved (within cap)");
}

async function main() {
  const ledger = new Ledger();
  const deps: GovernorDeps = {
    prava: new SandboxPrava({ mandates: MANDATES }),
    grounding: POLICY_CORPUS,
    ledger,
    clock: () => NOW,
  };

  console.log(`\n${"═".repeat(96)}`);
  console.log("  MetaboSpend — evidence packets");
  console.log("  Every routed proposal writes one of these, before any money moves.");
  console.log("═".repeat(96));

  const settled = restockAgent({
    sku: "WGT-114", description: "Widget case", distributionCenter: "DC-3",
    unitsOnHand: 40, dailyVelocity: 12, reorderPoint: 150,
    unitCost: "6.00", moq: 100, supplier: ACME,
  }, NOW)!;
  await propose(settled, POLICIES[AGENTS.restock], deps);
  render(ledger.get(settled.id)!, "A spend that happened — charged automatically, no human in the loop");

  const refused = restockAgent({
    sku: "BOX-220", description: "Corrugated box, 12in", distributionCenter: "DC-2",
    unitsOnHand: 90, dailyVelocity: 20, reorderPoint: 400,
    unitCost: "0.85", moq: 500, supplier: NORTHPORT,
  }, NOW)!;
  await propose(refused, POLICIES[AGENTS.restock], deps);
  render(ledger.get(refused.id)!, "A spend that did not — approved merchant, but no policy authorizing it");

  console.log(`\n${"═".repeat(96)}`);
  console.log("  Both rows are permanent. A refusal is an auditable event, not a silent drop.");
  console.log(`${"═".repeat(96)}\n`);
  ledger.close();
}

await main();
