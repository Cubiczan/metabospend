/**
 * Export the approval queue as mobile-ready cards.
 *
 *   npm run export:approvals > feed.json
 *
 * The governor already decides what needs a human; this projects those decisions
 * into the shape a phone can render. It is deliberately a *projection*, not a dump
 * of the evidence packet — a card carries only what someone needs in order to say
 * yes or no, and nothing that would need scrolling past.
 *
 * Three things are stripped on purpose:
 *
 *  - **No credentials, ever.** Network tokens and cryptograms are single-use and
 *    have no business leaving the server, let alone reaching a phone.
 *  - **No raw mandate ids.** A person recognises "the Acme mandate, $5,840 left",
 *    not `mdt_01KYT…`. The id travels in `decisionRef` for the callback only.
 *  - **No internal reason codes as the primary label.** They are included for
 *    filtering, but the card leads with the sentence a human actually reads.
 */
import { AGENTS, POLICIES, budgetAgent, renewalAgent, restockAgent } from "../lib/agents/index";
import { propose, type GovernorDeps } from "../lib/governor/execute";
import { format, toMinor } from "../lib/governor/money";
import type { Mandate, SpendProposal } from "../lib/governor/types";
import { SandboxPrava } from "../lib/prava/sandbox";
import { FixtureGroundingSource } from "../lib/senso/client";
import { Ledger, type EvidencePacket } from "../lib/store/ledger";

/** What one row in the phone's inbox needs. Stable contract — see Countersign. */
export interface ApprovalCard {
  /** Opaque id the app posts back with a decision. */
  id: string;
  /** Who proposed the spend. */
  agent: string;
  kind: "purchase" | "renewal" | "topup";
  /** Pre-formatted for display, so the client never does money math. */
  amountDisplay: string;
  amountMinor: number;
  currency: string;
  merchant: { name: string; url: string };
  /** One sentence: why the agent wants to spend. Shown under the amount. */
  why: string;
  /** Why a human is being asked at all. This is the headline on the card. */
  needsHumanBecause: string;
  /** Gates the proposal already cleared, as short chips. */
  gatesPassed: string[];
  /** Machine-readable, for filtering and analytics. Not the primary label. */
  reasonCodes: string[];
  /** The clause that authorizes this class of spend, if any. */
  authorizedBy: Array<{ source: string; excerpt: string }>;
  /** Human-legible mandate context — never the raw id. */
  fundingSource: string | null;
  /** ISO 8601. The client renders "queued 4 min ago" from this. */
  queuedAt: string;
  /** Opaque token the app returns when approving or rejecting. */
  decisionRef: string;
}

const NOW = new Date();
const WEEK = new Date(NOW.getTime() + 7 * 864e5).toISOString();

const ACME = { name: "Acme Supply", url: "https://acmesupply.com", country: "US" };
const SHIPSTATION = { name: "ShipStation", url: "https://shipstation.com", country: "US" };
const GOOGLE_ADS = { name: "Google Ads", url: "https://ads.google.com", country: "US" };

/**
 * Both mandates are merchant-scoped on purpose. A generic `any`-scope budget would
 * quietly cover the ShipStation renewal too, and the queue would then only ever
 * show one kind of card. Keeping them narrow means the export exercises both
 * reasons a spend reaches a human: over the agent's cap, and no standing
 * authorization at all — which are two different decisions to make.
 */
const MANDATES: Mandate[] = [
  { id: "mdt_acme", scope: "listed", merchantUrl: "https://acmesupply.com", remaining: "8000.00", currency: "USD", validUntil: WEEK, frequency: "one_time" },
  { id: "mdt_ads", scope: "listed", merchantUrl: "https://ads.google.com", remaining: "3000.00", currency: "USD", validUntil: WEEK, frequency: "one_time" },
];

const CORPUS = new FixtureGroundingSource([
  { agent: AGENTS.restock, merchantHost: "acmesupply.com", maxMinor: 1_000_000,
    source: "Procurement Policy v4 §3.2",
    excerpt: "Replenishment orders with approved suppliers may be issued by automated systems up to $10,000 per order." },
  { agent: AGENTS.renewal, merchantHost: "shipstation.com", maxMinor: 200_000,
    source: "Vendor Register 2026 §ShipStation",
    excerpt: "ShipStation is an approved recurring vendor; monthly renewals under $2,000 require no further authorization." },
]);

/** Turn reason codes into the one sentence that belongs at the top of the card. */
function headline(packet: EvidencePacket): string {
  const amount = format(packet.totalMinor, packet.currency);
  const cap = POLICIES[packet.agent]?.autoExecuteCap;
  if (packet.reasonCodes.includes("over_agent_cap")) {
    return `${amount} is over the ${packet.agent}'s ${cap ? format(toMinor(cap, packet.currency), packet.currency) : "spend"} limit`;
  }
  if (packet.reasonCodes.includes("no_mandate_match")) {
    return `No standing authorization covers ${packet.merchantName} — approving mints a one-time card`;
  }
  if (packet.reasonCodes.includes("mandate_insufficient_remaining")) {
    return `The ${packet.merchantName} budget does not have ${amount} left`;
  }
  if (packet.reasonCodes.includes("mandate_expired")) {
    return `The ${packet.merchantName} authorization has expired`;
  }
  return `${amount} needs your approval`;
}

/** Mandate context in words, never as an id. */
function fundingSource(packet: EvidencePacket): string | null {
  if (packet.mandateId === null) return null;
  const mandate = MANDATES.find((m) => m.id === packet.mandateId);
  if (!mandate) return null;
  const left = format(toMinor(mandate.remaining, mandate.currency), mandate.currency);
  return mandate.scope === "listed"
    ? `${packet.merchantName} mandate · ${left} remaining`
    : `Operations budget · ${left} remaining`;
}

const GATE_LABELS: Record<string, string> = {
  mandate_covers_spend: "Funds authorized",
  within_agent_cap: "Within limit",
  over_agent_cap: "Over limit",
  no_mandate_match: "No standing authorization",
  mandate_insufficient_remaining: "Budget exhausted",
  mandate_expired: "Authorization expired",
};

export function toCard(packet: EvidencePacket): ApprovalCard {
  return {
    id: packet.proposalId,
    agent: packet.agent,
    kind: packet.proposalId.startsWith("renew") ? "renewal" : packet.proposalId.startsWith("topup") ? "topup" : "purchase",
    amountDisplay: format(packet.totalMinor, packet.currency),
    amountMinor: packet.totalMinor,
    currency: packet.currency,
    merchant: { name: packet.merchantName, url: packet.merchantUrl },
    why: packet.rationale,
    needsHumanBecause: headline(packet),
    // Only the gates that represent something cleared, in the order they ran.
    gatesPassed: packet.reasonCodes
      .filter((c) => c === "mandate_covers_spend" || c === "within_agent_cap")
      .map((c) => GATE_LABELS[c] ?? c),
    reasonCodes: packet.reasonCodes,
    authorizedBy: packet.citations.map((c) => ({ source: c.source, excerpt: c.excerpt })),
    fundingSource: fundingSource(packet),
    queuedAt: packet.decidedAt,
    // Opaque to the client. In production this would be signed.
    decisionRef: Buffer.from(`${packet.proposalId}:${packet.mandateId ?? "session"}`).toString("base64url"),
  };
}

async function main() {
  const ledger = new Ledger();
  const deps: GovernorDeps = {
    prava: new SandboxPrava({ mandates: MANDATES }),
    grounding: CORPUS,
    ledger,
    clock: () => NOW,
  };

  const proposals: SpendProposal[] = [];
  const push = (p: SpendProposal | null) => { if (p) proposals.push(p); };

  // Over cap — the classic case a person has to clear.
  push(restockAgent({
    sku: "PLT-900", description: "Pallet, heavy duty", distributionCenter: "DC-1",
    unitsOnHand: 5, dailyVelocity: 9, reorderPoint: 60,
    unitCost: "14.00", moq: 250, supplier: ACME,
  }, NOW));

  // No mandate for this merchant — approving mints a one-time card via passkey.
  push(renewalAgent({
    vendor: SHIPSTATION, plan: "Enterprise plan", monthlyCost: "1400.00",
    renewsOn: new Date(NOW.getTime() + 2 * 864e5).toISOString().slice(0, 10),
    attributedValue: "6200.00", seatsUsed: 12, seatsPaid: 15,
  }, NOW));

  // Over the Budget Agent's cap, drawing on the generic operations budget.
  push(budgetAgent({
    channel: GOOGLE_ADS, campaign: "Brand — Search",
    balance: "120.00", dailySpend: "240.00", roas: 3.9, targetRoas: 2.0,
  }, NOW));

  for (const proposal of proposals) {
    await propose(proposal, POLICIES[proposal.agent], deps);
  }

  const cards = ledger
    .list({ lane: "approval" })
    .filter((p) => p.settlement === "awaiting_approval")
    .map(toCard);

  console.log(JSON.stringify({
    generatedAt: NOW.toISOString(),
    // The app posts decisions here. native.builder owns the endpoint; this is
    // only the shape it should expect and reply to.
    decisionCallback: "POST /approvals/{id}/decide  { decision: 'approve'|'reject', note?: string }",
    pending: cards,
  }, null, 2));

  ledger.close();
}

await main();
