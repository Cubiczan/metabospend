/**
 * The three agents.
 *
 * Each one watches a different operational signal and turns it into a spend
 * proposal. They deliberately do *not* decide whether the spend is allowed —
 * that is the governor's job, and keeping the two apart is what makes the
 * authority model auditable. An agent's only obligations are to itemize honestly
 * (its total must equal the sum of its own line items, or gate 1 refuses it) and
 * to state a rationale a human can read.
 *
 * The roster and the "metabolic systems" framing are drawn from metabocommand;
 * the spend proposals are new.
 */
import type { AgentPolicy, LineItem, Merchant, SpendProposal } from "../governor/types";
import { toDecimal, toMinor } from "../governor/money";

export const AGENTS = {
  restock: "Restock Agent",
  renewal: "Renewal Agent",
  budget: "Budget Agent",
} as const;

/**
 * Per-agent spend authority. These caps are the deliberately conservative half of
 * the control pair — the Prava mandate cap is the other half, and a spend needs
 * both to clear without a person.
 */
export const POLICIES: Record<string, AgentPolicy> = {
  [AGENTS.restock]: {
    agent: AGENTS.restock,
    autoExecuteCap: "2500.00",
    currency: "USD",
    allowedMerchants: ["acmesupply.com", "northportpackaging.com"],
    // Procurement spends other people's money at suppliers. It does not move
    // without a policy citation.
    requiresGroundedPolicy: true,
  },
  [AGENTS.renewal]: {
    agent: AGENTS.renewal,
    autoExecuteCap: "500.00",
    currency: "USD",
    allowedMerchants: ["shipstation.com", "klaviyo.com", "gorgias.com"],
    requiresGroundedPolicy: true,
  },
  [AGENTS.budget]: {
    agent: AGENTS.budget,
    autoExecuteCap: "1000.00",
    currency: "USD",
    allowedMerchants: ["ads.google.com", "business.facebook.com"],
    requiresGroundedPolicy: false,
  },
};

// ─── Restock Agent — Inventory Intelligence ───────────────────────────────────

export interface StockSignal {
  sku: string;
  description: string;
  distributionCenter: string;
  unitsOnHand: number;
  dailyVelocity: number;
  reorderPoint: number;
  unitCost: string;
  /** Minimum order quantity the supplier will accept. */
  moq: number;
  supplier: Merchant;
}

/**
 * Propose a purchase order when a SKU will run out before a replenishment can
 * land. Order quantity covers 30 days of demand, rounded up to the supplier's
 * MOQ — under-ordering to stay beneath a threshold would be gaming the control,
 * so the amount is set by the operational need and the governor decides.
 */
export function restockAgent(signal: StockSignal, now: Date): SpendProposal | null {
  if (signal.unitsOnHand > signal.reorderPoint) return null;

  const daysOfCover = signal.dailyVelocity > 0
    ? Math.floor(signal.unitsOnHand / signal.dailyVelocity)
    : Infinity;
  const quantity = Math.max(signal.moq, Math.ceil(signal.dailyVelocity * 30));

  return buildProposal({
    id: `restock_${signal.sku}_${now.toISOString().slice(0, 10)}`,
    agent: AGENTS.restock,
    kind: "purchase",
    merchant: signal.supplier,
    items: [{ description: `${signal.description} (${signal.sku})`, unit_price: signal.unitCost, quantity }],
    currency: "USD",
    rationale:
      `${signal.sku} is at ${signal.unitsOnHand} units in ${signal.distributionCenter}, ` +
      `below the ${signal.reorderPoint}-unit reorder point — ` +
      `${Number.isFinite(daysOfCover) ? `${daysOfCover} days of cover left` : "no measured velocity"} ` +
      `at ${signal.dailyVelocity}/day. Ordering ${quantity} units for 30 days of cover.`,
  });
}

// ─── Renewal Agent — Customer Lifetime ────────────────────────────────────────

export interface SubscriptionSignal {
  vendor: Merchant;
  plan: string;
  monthlyCost: string;
  renewsOn: string;
  /** Attributed monthly contribution. Below cost, the tool is not earning its keep. */
  attributedValue: string;
  seatsUsed: number;
  seatsPaid: number;
}

/**
 * Renew a subscription only when it earns more than it costs. A tool that does not
 * is surfaced as a cancellation candidate rather than renewed — the agent returns
 * null and the reason lands in the operator's queue, because "don't spend" is a
 * decision the governor never needs to see.
 */
export function renewalAgent(signal: SubscriptionSignal, now: Date): SpendProposal | null {
  const costMinor = toMinor(signal.monthlyCost, "USD");
  const valueMinor = toMinor(signal.attributedValue, "USD");
  if (valueMinor <= costMinor) return null;

  // Only pay for seats in use. Trimming idle seats is the cheapest real saving
  // this agent can produce, so it is priced in before the proposal is made.
  const billableSeats = Math.max(1, signal.seatsUsed);
  const perSeat = Math.floor(costMinor / Math.max(1, signal.seatsPaid));
  const idleSeats = Math.max(0, signal.seatsPaid - signal.seatsUsed);

  return buildProposal({
    id: `renew_${hostOf(signal.vendor.url)}_${signal.renewsOn}`,
    agent: AGENTS.renewal,
    kind: "renewal",
    merchant: signal.vendor,
    items: [{ description: `${signal.plan} — ${billableSeats} seat(s)`, unit_price: toDecimal(perSeat), quantity: billableSeats }],
    currency: "USD",
    rationale:
      `${signal.vendor.name} ${signal.plan} renews ${signal.renewsOn}. ` +
      `Attributed value ${signal.attributedValue} exceeds cost ${signal.monthlyCost}. ` +
      (idleSeats > 0
        ? `Dropping ${idleSeats} idle seat(s), saving ${toDecimal(perSeat * idleSeats)}/mo.`
        : `All ${signal.seatsPaid} seats in use.`),
  });
}

// ─── Budget Agent — Revenue Velocity ─────────────────────────────────────────

export interface AdChannelSignal {
  channel: Merchant;
  campaign: string;
  balance: string;
  dailySpend: string;
  /** Return on ad spend. Below 1.0 the channel loses money per dollar. */
  roas: number;
  targetRoas: number;
}

/**
 * Top up an ad account that is converting and about to run dry. Channels below
 * target ROAS are not topped up at all — the agent's job is to keep working
 * spend alive, not to defend a budget line.
 */
export function budgetAgent(signal: AdChannelSignal, now: Date): SpendProposal | null {
  if (signal.roas < signal.targetRoas) return null;

  const balanceMinor = toMinor(signal.balance, "USD");
  const dailyMinor = toMinor(signal.dailySpend, "USD");
  if (dailyMinor === 0) return null;

  const daysLeft = Math.floor(balanceMinor / dailyMinor);
  if (daysLeft > 3) return null;

  // Seven days of runway — long enough to matter, short enough that a
  // deteriorating channel gets re-examined within the week.
  const topUpMinor = dailyMinor * 7;

  return buildProposal({
    id: `topup_${hostOf(signal.channel.url)}_${now.toISOString().slice(0, 10)}`,
    agent: AGENTS.budget,
    kind: "topup",
    merchant: signal.channel,
    items: [{ description: `${signal.campaign} — 7 days of budget`, unit_price: toDecimal(dailyMinor), quantity: 7 }],
    currency: "USD",
    rationale:
      `${signal.campaign} on ${signal.channel.name} is at ${signal.roas.toFixed(2)}× ROAS ` +
      `(target ${signal.targetRoas.toFixed(2)}×) with ${daysLeft} day(s) of budget left. ` +
      `Topping up 7 days at ${signal.dailySpend}/day.`,
  });
}

// ─── shared ──────────────────────────────────────────────────────────────────

/**
 * Build a proposal with the total derived from the line items, never stated
 * independently. Gate 1 refuses any mismatch, so computing it here means an agent
 * cannot accidentally propose a total it did not itemize.
 */
function buildProposal(args: {
  id: string;
  agent: string;
  kind: SpendProposal["kind"];
  merchant: Merchant;
  items: LineItem[];
  currency: string;
  rationale: string;
}): SpendProposal {
  const totalMinor = args.items.reduce(
    (sum, item) => sum + toMinor(item.unit_price, args.currency) * item.quantity,
    0,
  );
  return {
    id: args.id,
    agent: args.agent,
    kind: args.kind,
    merchant: args.merchant,
    total: toDecimal(totalMinor),
    currency: args.currency,
    items: args.items,
    rationale: args.rationale,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\./g, "-");
  } catch {
    return "unknown";
  }
}
