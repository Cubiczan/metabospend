/**
 * The governor's contract.
 *
 * One idea holds the whole product together: an agent's **auto-execute
 * threshold** and a Prava **mandate cap** are the same control expressed at two
 * layers. The threshold is what *we* let an agent do without a human; the cap is
 * what the *card network* will actually authorize. A spend is a reflex only when
 * both agree. Everything else escalates to a person or is refused.
 */

/** Lanes a proposal can be routed into. Deny-by-default: `blocked` is the fallback. */
export type Lane =
  /** Below the agent's cap and covered by an active mandate — charge now, no human. */
  | "auto"
  /** Legitimate but needs a person: over cap, or no mandate covers it (mint a passkey session). */
  | "approval"
  /** Refused outright: bad money, merchant off-policy, or no grounded policy citation. */
  | "blocked";

/** Why a proposal landed where it did. Stable machine-readable codes for the audit trail. */
export type ReasonCode =
  | "invalid_amount"
  | "currency_mismatch"
  | "merchant_not_allowed"
  | "policy_not_grounded"
  | "no_mandate_match"
  | "mandate_insufficient_remaining"
  | "mandate_expired"
  | "over_agent_cap"
  | "within_agent_cap"
  | "mandate_covers_spend";

export interface Reason {
  code: ReasonCode;
  detail: string;
}

export interface Merchant {
  name: string;
  /** Full URL including scheme — Prava rejects bare hostnames. */
  url: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export interface LineItem {
  description: string;
  /** Decimal string, e.g. "12.00". */
  unit_price: string;
  quantity: number;
}

/** What one of our agents wants to spend money on. */
export interface SpendProposal {
  id: string;
  /** Which agent proposed it — determines which policy applies. */
  agent: string;
  kind: "purchase" | "renewal" | "topup";
  merchant: Merchant;
  /** Decimal string. Must equal the sum of line items. */
  total: string;
  currency: string;
  items: LineItem[];
  /** Free-text rationale from the agent, shown to approvers. */
  rationale: string;
}

/** Per-agent spend authority. This is the metabocommand "agent threshold" table. */
export interface AgentPolicy {
  agent: string;
  /** Decimal string. At or below this, and with a mandate, the spend is a reflex. */
  autoExecuteCap: string;
  currency: string;
  /** Hostnames the agent may transact with, or "any". */
  allowedMerchants: string[] | "any";
  /**
   * When true, the spend is refused unless Senso returns a citation from
   * verified policy ground truth. Procurement agents run with this on.
   */
  requiresGroundedPolicy: boolean;
}

/** A Prava mandate, normalized from `prava mandate list --json`. */
export interface Mandate {
  id: string;
  scope: "listed" | "any";
  /** Present only for `listed` scope. */
  merchantUrl: string | null;
  /** Decimal string of the remaining authorized amount. Indicative — the server enforces. */
  remaining: string;
  currency: string;
  /** ISO 8601. */
  validUntil: string;
  frequency: "one_time" | "weekly" | "monthly" | "yearly";
}

/** Senso grounding result: did verified policy actually authorize this class of spend? */
export interface Grounding {
  cited: boolean;
  citations: Array<{ source: string; excerpt: string; url?: string }>;
}

export interface RouteInput {
  proposal: SpendProposal;
  policy: AgentPolicy;
  mandates: Mandate[];
  grounding: Grounding;
  /** Injected so decay/expiry is deterministic in tests. */
  now: Date;
}

export interface Decision {
  proposalId: string;
  lane: Lane;
  reasons: Reason[];
  /** Set when lane is "auto", or when an approver's yes can be settled against a mandate. */
  mandateId: string | null;
  /** Minor units, for the ledger. */
  totalMinor: number;
  currency: string;
}
