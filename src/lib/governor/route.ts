import { MoneyError, format, toMinor } from "./money";
import type { Decision, Grounding, Mandate, Reason, RouteInput } from "./types";

/**
 * The routing engine: one pure function from (proposal, policy, mandates,
 * grounding, clock) to a lane. No I/O, no clock reads, no randomness — so the
 * money math is characterizable in tests and reproducible in an audit.
 *
 * Gate order is deliberate and deny-first. Cheap structural checks run before
 * expensive trust checks, and every gate that can refuse runs before any gate
 * that can approve. A proposal reaches `auto` only by surviving all of them.
 */
export function route(input: RouteInput): Decision {
  const { proposal, policy, mandates, grounding, now } = input;
  const reasons: Reason[] = [];

  // Carries the attempted amount into a refusal once gate 1 has established it.
  // "We refused a $510 spend" is a useful audit record; "we refused $0.00" is not.
  let attemptedMinor = 0;

  const blocked = (extra: Reason): Decision => ({
    proposalId: proposal.id,
    lane: "blocked",
    reasons: [...reasons, extra],
    mandateId: null,
    totalMinor: attemptedMinor,
    currency: proposal.currency,
  });

  // Gate 1 — money is well-formed, and the line items actually sum to the total.
  // An agent that proposes a total unrelated to its own line items is the single
  // most dangerous failure mode here, so it is refused rather than escalated.
  let totalMinor: number;
  let capMinor: number;
  try {
    totalMinor = toMinor(proposal.total, proposal.currency);
    capMinor = toMinor(policy.autoExecuteCap, policy.currency);
    const itemsMinor = proposal.items.reduce((sum, item) => {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new MoneyError(`quantity must be a positive integer, got ${item.quantity}`);
      }
      return sum + toMinor(item.unit_price, proposal.currency) * item.quantity;
    }, 0);
    if (itemsMinor !== totalMinor) {
      return blocked({
        code: "invalid_amount",
        detail: `total ${format(totalMinor, proposal.currency)} does not equal the sum of line items ${format(itemsMinor, proposal.currency)}`,
      });
    }
    if (totalMinor === 0) {
      throw new MoneyError("total must be greater than zero");
    }
    attemptedMinor = totalMinor;
  } catch (error) {
    return blocked({
      code: "invalid_amount",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Gate 2 — the agent's policy and the proposal must be denominated the same
  // way, or the cap comparison below is meaningless.
  if (policy.currency !== proposal.currency) {
    return blocked({
      code: "currency_mismatch",
      detail: `agent ${policy.agent} is capped in ${policy.currency} but the proposal is in ${proposal.currency}`,
    });
  }

  // Gate 3 — merchant allowlist. Compared on hostname, so a policy entry stays
  // valid across path and query changes.
  if (policy.allowedMerchants !== "any") {
    const host = hostnameOf(proposal.merchant.url);
    if (host === null) {
      return blocked({
        code: "merchant_not_allowed",
        detail: `merchant url ${JSON.stringify(proposal.merchant.url)} is not a valid absolute URL`,
      });
    }
    const allowed = policy.allowedMerchants.some((entry) => hostMatches(host, entry));
    if (!allowed) {
      return blocked({
        code: "merchant_not_allowed",
        detail: `${host} is not in the allowlist for ${policy.agent}`,
      });
    }
  }

  // Gate 4 — the Senso trust gate. For agents that require it, spend without a
  // citation from verified policy ground truth is refused. This is what makes an
  // evidence packet worth anything: the authorization is traceable to a source
  // document, not to the agent's own say-so.
  if (policy.requiresGroundedPolicy && !isGrounded(grounding)) {
    return blocked({
      code: "policy_not_grounded",
      detail: `${policy.agent} requires a verified policy citation and none was returned`,
    });
  }

  // Gate 5 — find a mandate that can actually carry this charge. Merchant-specific
  // mandates win over generic ones: spending a broad budget when a narrow
  // authorization exists needlessly consumes the wider allowance.
  const match = selectMandate(mandates, proposal.merchant.url, proposal.currency, totalMinor, now);
  reasons.push(...match.reasons);

  if (match.mandate === null) {
    // Not a refusal. With no mandate to draw on, the correct Prava path is to
    // mint a session the person approves with a passkey — which is exactly what
    // the approval lane does.
    return {
      proposalId: proposal.id,
      lane: "approval",
      reasons,
      mandateId: null,
      totalMinor,
      currency: proposal.currency,
    };
  }

  // Gate 6 — the threshold. Both controls now agree, so this can be a reflex.
  if (totalMinor > capMinor) {
    reasons.push({
      code: "over_agent_cap",
      detail: `${format(totalMinor, proposal.currency)} exceeds the ${format(capMinor, policy.currency)} auto-execute cap for ${policy.agent}`,
    });
    return {
      proposalId: proposal.id,
      lane: "approval",
      reasons,
      mandateId: match.mandate.id,
      totalMinor,
      currency: proposal.currency,
    };
  }

  reasons.push({
    code: "within_agent_cap",
    detail: `${format(totalMinor, proposal.currency)} is within the ${format(capMinor, policy.currency)} auto-execute cap for ${policy.agent}`,
  });
  return {
    proposalId: proposal.id,
    lane: "auto",
    reasons,
    mandateId: match.mandate.id,
    totalMinor,
    currency: proposal.currency,
  };
}

/** Grounding counts only when the claim and the evidence are both present. */
function isGrounded(grounding: Grounding): boolean {
  return grounding.cited && grounding.citations.length > 0;
}

interface MandateMatch {
  mandate: Mandate | null;
  reasons: Reason[];
}

/**
 * Pick the narrowest mandate that can carry the charge.
 *
 * `remaining` is treated as indicative — Prava's server enforces the real cap and
 * a THRESHOLD_EXCEEDED decline is a normal outcome, not a bug. Screening on it
 * here just avoids proposing a charge we already know will fail.
 */
function selectMandate(
  mandates: Mandate[],
  merchantUrl: string,
  currency: string,
  totalMinor: number,
  now: Date,
): MandateMatch {
  const host = hostnameOf(merchantUrl);
  const reasons: Reason[] = [];

  const sameCurrency = mandates.filter((m) => m.currency === currency);
  const scoped = sameCurrency.filter(
    (m) => m.scope === "any" || (host !== null && hostMatches(host, m.merchantUrl ?? "")),
  );

  if (scoped.length === 0) {
    reasons.push({
      code: "no_mandate_match",
      detail: `no ${currency} mandate covers ${host ?? merchantUrl}`,
    });
    return { mandate: null, reasons };
  }

  const live = scoped.filter((m) => !isExpired(m, now));
  if (live.length === 0) {
    reasons.push({
      code: "mandate_expired",
      detail: `every matching ${currency} mandate for ${host ?? merchantUrl} has expired`,
    });
    return { mandate: null, reasons };
  }

  const funded = live.filter((m) => safeRemaining(m) >= totalMinor);
  if (funded.length === 0) {
    const best = Math.max(...live.map(safeRemaining));
    reasons.push({
      code: "mandate_insufficient_remaining",
      detail: `charge of ${format(totalMinor, currency)} exceeds the largest remaining balance of ${format(best, currency)}`,
    });
    return { mandate: null, reasons };
  }

  // Narrowest first (listed beats any); among equals, the one expiring soonest,
  // so short-dated authorizations get used before they lapse.
  const chosen = funded.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "listed" ? -1 : 1;
    return Date.parse(a.validUntil) - Date.parse(b.validUntil);
  })[0];

  reasons.push({
    code: "mandate_covers_spend",
    detail: `${chosen.scope === "listed" ? "merchant-specific" : "generic"} mandate has ${format(safeRemaining(chosen), currency)} remaining, expiring ${chosen.validUntil}`,
  });
  return { mandate: chosen, reasons };
}

/** A mandate whose window we cannot parse is treated as expired, never as live. */
function isExpired(mandate: Mandate, now: Date): boolean {
  const until = Date.parse(mandate.validUntil);
  return Number.isNaN(until) || until <= now.getTime();
}

/** An unparseable remaining balance is treated as zero, never as unlimited. */
function safeRemaining(mandate: Mandate): number {
  try {
    return toMinor(mandate.remaining, mandate.currency);
  } catch {
    return 0;
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Match a hostname against an allowlist entry, which may be a bare hostname
 * ("nike.com") or a full URL. Subdomains of an allowed host match; lookalike
 * suffixes ("evil-nike.com") deliberately do not.
 */
function hostMatches(host: string, entry: string): boolean {
  if (entry === "") return false;
  const normalized = entry.includes("://")
    ? hostnameOf(entry)
    : entry.toLowerCase().replace(/^www\./, "");
  if (normalized === null || normalized === "") return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}
