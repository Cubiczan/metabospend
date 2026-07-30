/**
 * The execution path — where a decision becomes money.
 *
 * `route()` is pure; this is the part with side effects, kept deliberately thin so
 * the interesting logic stays testable. It enforces three invariants that the
 * routing engine cannot enforce on its own:
 *
 *  1. **Evidence before money.** The packet is written before any Prava call, so a
 *     charge cannot exist without the decision that authorized it.
 *  2. **Every charge is reported.** A mandate charge that is never settled leaves
 *     the card network holding an open authorization. The report happens in a
 *     `finally`, so it survives a merchant-side failure.
 *  3. **The approval lane never auto-mints.** Minting a session produces a
 *     passkey prompt a person may approve on autopilot, so the human decision has
 *     to come first — `settleApproved` is reachable only after `Ledger.approve`.
 */
import { PravaError, type PaymentCredential, type PravaGateway } from "../prava/client";
import { Ledger, type EvidencePacket } from "../store/ledger";
import { toDecimal } from "./money";
import { route } from "./route";
import type { AgentPolicy, Grounding, SpendProposal } from "./types";
import type { GroundingSource } from "../senso/client";

export interface ExecuteResult {
  packet: EvidencePacket;
  /** Present only when a charge actually succeeded. Never logged or persisted. */
  credential: PaymentCredential | null;
  /** For the approval lane, the URL a person must approve with a passkey. */
  paymentUrl: string | null;
}

export interface GovernorDeps {
  prava: PravaGateway;
  grounding: GroundingSource;
  ledger: Ledger;
  /** Injected so the ledger's timestamps are deterministic in tests. */
  clock?: () => Date;
}

/**
 * Route one proposal and, if it lands in the auto lane, charge it.
 *
 * Returns the evidence packet in every case, including refusals — a blocked spend
 * is an auditable event, not a silent drop.
 */
export async function propose(
  proposal: SpendProposal,
  policy: AgentPolicy,
  deps: GovernorDeps,
): Promise<ExecuteResult> {
  const now = deps.clock ?? (() => new Date());

  // Grounding is fetched before routing because gate 4 consumes it. A failure
  // here resolves to "not grounded", which refuses rather than permits.
  const grounding: Grounding = await deps.grounding.ground(proposal).catch(() => ({ cited: false, citations: [] }));

  // Mandates come from Prava, not from our own bookkeeping — the network is the
  // authority on what is actually authorized. If we cannot read them, we treat
  // the account as having none, which escalates to a person.
  const mandates = await deps.prava.listMandates().catch(() => []);

  const decision = route({ proposal, policy, mandates, grounding, now: now() });
  const { packet, inserted } = deps.ledger.recordDecision({ proposal, decision, grounding, decidedAt: now() });

  // A proposal id we have already decided on must never be charged again. This is
  // the guard against a retried or replayed proposal turning into a second
  // payment — the ledger row is the idempotency key.
  if (!inserted) {
    return { packet, credential: null, paymentUrl: null };
  }

  if (decision.lane !== "auto") {
    // Blocked stays blocked. Approval waits for a person; the session is minted
    // later, by settleApproved, once someone has actually said yes.
    return { packet, credential: null, paymentUrl: null };
  }

  const charged = await chargeAndSettle(proposal, decision.mandateId!, decision.totalMinor, deps);
  return { ...charged, paymentUrl: null };
}

/**
 * Complete an approval-lane proposal after a human cleared it.
 *
 * Two paths, chosen by whether a mandate can carry the charge: settle against the
 * mandate if one covers it, otherwise mint a session and let the approver confirm
 * with a passkey in the browser.
 */
export async function settleApproved(
  proposal: SpendProposal,
  deps: GovernorDeps,
  approvedBy: string,
): Promise<ExecuteResult> {
  const now = deps.clock ?? (() => new Date());
  const existing = deps.ledger.get(proposal.id);
  if (existing === null) throw new Error(`no decision on record for ${proposal.id}`);
  if (existing.settlement !== "awaiting_approval") {
    throw new Error(`${proposal.id} is ${existing.settlement}, not awaiting approval`);
  }
  if (!deps.ledger.approve({ proposalId: proposal.id, approvedBy })) {
    throw new Error(`could not record approval for ${proposal.id}`);
  }

  if (existing.mandateId !== null) {
    const charged = await chargeAndSettle(proposal, existing.mandateId, existing.totalMinor, deps);
    return { ...charged, paymentUrl: null };
  }

  // No mandate to draw on: mint a session. The person approves with a passkey,
  // which is the consent for this single charge.
  try {
    const session = await deps.prava.createSession({
      total: toDecimal(existing.totalMinor),
      currency: existing.currency,
      merchant: proposal.merchant,
      items: proposal.items,
    });
    const credential = await deps.prava.pollSession(session.sessionId);
    deps.ledger.settle({
      proposalId: proposal.id,
      settlement: "settled",
      txnId: credential.txnId || session.sessionId,
      settledAt: now(),
    });
    return {
      packet: deps.ledger.get(proposal.id)!,
      credential,
      paymentUrl: session.paymentUrl,
    };
  } catch (error) {
    deps.ledger.settle({ proposalId: proposal.id, settlement: "failed", settledAt: now() });
    if (error instanceof PravaError) {
      return { packet: deps.ledger.get(proposal.id)!, credential: null, paymentUrl: null };
    }
    throw error;
  }
}

/**
 * Charge a mandate and report the outcome back to the network.
 *
 * The report lives in a `finally` on purpose: if the merchant checkout throws
 * after we hold a credential, the authorization still has to be closed out.
 */
async function chargeAndSettle(
  proposal: SpendProposal,
  mandateId: string,
  totalMinor: number,
  deps: GovernorDeps,
): Promise<{ packet: EvidencePacket; credential: PaymentCredential | null }> {
  const now = deps.clock ?? (() => new Date());
  let credential: PaymentCredential | null = null;
  let networkStatus: "APPROVED" | "DECLINED" = "DECLINED";

  try {
    const result = await deps.prava.chargeMandate({
      mandateId,
      amount: toDecimal(totalMinor),
      reference: proposal.id,
    });

    if (!result.ok) {
      // A decline is a normal outcome to relay, not an exception to swallow.
      deps.ledger.settle({ proposalId: proposal.id, settlement: "declined", settledAt: now() });
      return { packet: deps.ledger.get(proposal.id)!, credential: null };
    }

    credential = result.credential;
    networkStatus = "APPROVED";
    deps.ledger.settle({
      proposalId: proposal.id,
      settlement: "settled",
      txnId: credential.txnId,
      settledAt: now(),
    });
    return { packet: deps.ledger.get(proposal.id)!, credential };
  } catch (error) {
    deps.ledger.settle({ proposalId: proposal.id, settlement: "failed", settledAt: now() });
    if (error instanceof PravaError) {
      return { packet: deps.ledger.get(proposal.id)!, credential: null };
    }
    throw error;
  } finally {
    if (credential?.txnId) {
      // Best effort, and deliberately not allowed to mask the charge result.
      await deps.prava
        .reportMandateCharge({ mandateId, txnId: credential.txnId, status: networkStatus })
        .catch(() => undefined);
    }
  }
}
