/**
 * The spend ledger and evidence store.
 *
 * Backed by Node's built-in `node:sqlite` — zero npm dependencies, server-only.
 * Two tables and two indexes are the whole coordination surface; a spend control
 * plane does not need an external service to be auditable.
 *
 * The design rule here is that the ledger is **append-only for facts and
 * single-transition for state**. An evidence packet is written the moment the
 * governor decides, before any money moves, so a charge can never exist without
 * the decision that authorized it. Settlement is a guarded UPDATE that only
 * advances a row out of `pending`, which makes double-settling a no-op rather
 * than a second charge.
 */
import { DatabaseSync } from "node:sqlite";

import type { Decision, Grounding, SpendProposal } from "../governor/types";

export type Settlement = "pending" | "settled" | "declined" | "failed" | "refused" | "awaiting_approval";

export interface EvidencePacket {
  proposalId: string;
  agent: string;
  lane: Decision["lane"];
  merchantName: string;
  merchantUrl: string;
  totalMinor: number;
  currency: string;
  rationale: string;
  reasonCodes: string[];
  reasonDetail: string;
  citations: Grounding["citations"];
  mandateId: string | null;
  txnId: string | null;
  settlement: Settlement;
  decidedAt: string;
  settledAt: string | null;
  /** Set when a human cleared the approval lane. */
  approvedBy: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  proposal_id   TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  lane          TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  merchant_url  TEXT NOT NULL,
  total_minor   INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  reason_codes  TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  citations     TEXT NOT NULL,
  mandate_id    TEXT,
  txn_id        TEXT,
  settlement    TEXT NOT NULL,
  decided_at    TEXT NOT NULL,
  settled_at    TEXT,
  approved_by   TEXT
);
CREATE INDEX IF NOT EXISTS evidence_by_lane  ON evidence (lane, decided_at DESC);
CREATE INDEX IF NOT EXISTS evidence_by_agent ON evidence (agent, decided_at DESC);
`;

export class Ledger {
  private readonly db: DatabaseSync;

  /** Defaults to an in-memory database, which is what the tests and the demo use. */
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  /**
   * Record a decision before any money moves. Idempotent on proposal id, so a
   * retried route never produces a second authorization to charge against.
   *
   * `inserted` is the caller's guard against a double charge: it is true only for
   * the attempt that actually created the row. A retry gets `inserted: false` and
   * the packet as it already stands, and must not proceed to payment.
   */
  recordDecision(args: {
    proposal: SpendProposal;
    decision: Decision;
    grounding: Grounding;
    decidedAt: Date;
  }): { packet: EvidencePacket; inserted: boolean } {
    const { proposal, decision, grounding, decidedAt } = args;
    const settlement: Settlement =
      decision.lane === "blocked" ? "refused"
      : decision.lane === "approval" ? "awaiting_approval"
      : "pending";

    const result = this.db.prepare(`
      INSERT INTO evidence (
        proposal_id, agent, lane, merchant_name, merchant_url, total_minor, currency,
        rationale, reason_codes, reason_detail, citations, mandate_id, txn_id,
        settlement, decided_at, settled_at, approved_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(proposal_id) DO NOTHING
    `).run(
      proposal.id,
      proposal.agent,
      decision.lane,
      proposal.merchant.name,
      proposal.merchant.url,
      decision.totalMinor,
      decision.currency,
      proposal.rationale,
      JSON.stringify(decision.reasons.map((r) => r.code)),
      decision.reasons.map((r) => r.detail).join("; "),
      JSON.stringify(grounding.citations),
      decision.mandateId,
      null,
      settlement,
      decidedAt.toISOString(),
      null,
      null,
    );

    const packet = this.get(proposal.id);
    if (packet === null) throw new Error(`failed to record evidence for ${proposal.id}`);
    return { packet, inserted: result.changes === 1 };
  }

  /**
   * Advance a row out of `pending`. Guarded on the current state, so a duplicate
   * settlement is a no-op and returns false rather than overwriting an outcome.
   */
  settle(args: {
    proposalId: string;
    settlement: Exclude<Settlement, "pending" | "awaiting_approval">;
    txnId?: string | null;
    settledAt: Date;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE evidence
         SET settlement = ?, txn_id = COALESCE(?, txn_id), settled_at = ?
       WHERE proposal_id = ? AND settlement = 'pending'
    `).run(args.settlement, args.txnId ?? null, args.settledAt.toISOString(), args.proposalId);
    return result.changes === 1;
  }

  /** Clear an approval-lane item. Returns false if it was not awaiting approval. */
  approve(args: { proposalId: string; approvedBy: string }): boolean {
    const result = this.db.prepare(`
      UPDATE evidence SET settlement = 'pending', approved_by = ?
       WHERE proposal_id = ? AND settlement = 'awaiting_approval'
    `).run(args.approvedBy, args.proposalId);
    return result.changes === 1;
  }

  reject(args: { proposalId: string; approvedBy: string }): boolean {
    const result = this.db.prepare(`
      UPDATE evidence SET settlement = 'refused', approved_by = ?
       WHERE proposal_id = ? AND settlement = 'awaiting_approval'
    `).run(args.approvedBy, args.proposalId);
    return result.changes === 1;
  }

  get(proposalId: string): EvidencePacket | null {
    const row = this.db.prepare("SELECT * FROM evidence WHERE proposal_id = ?").get(proposalId);
    return row ? hydrate(row as Record<string, unknown>) : null;
  }

  list(filter: { lane?: Decision["lane"]; agent?: string; limit?: number } = {}): EvidencePacket[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.lane) { where.push("lane = ?"); params.push(filter.lane); }
    if (filter.agent) { where.push("agent = ?"); params.push(filter.agent); }
    const sql = `SELECT * FROM evidence ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY decided_at DESC LIMIT ?`;
    params.push(filter.limit ?? 100);
    const rows = this.db.prepare(sql).all(...params as never[]);
    return (rows as Record<string, unknown>[]).map(hydrate);
  }

  /** Total actually settled, per currency. What a CFO asks for first. */
  settledTotals(): Array<{ currency: string; totalMinor: number; charges: number }> {
    const rows = this.db.prepare(`
      SELECT currency, SUM(total_minor) AS total_minor, COUNT(*) AS charges
        FROM evidence WHERE settlement = 'settled' GROUP BY currency
    `).all();
    return (rows as Record<string, unknown>[]).map((r) => ({
      currency: String(r.currency),
      totalMinor: Number(r.total_minor),
      charges: Number(r.charges),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function hydrate(row: Record<string, unknown>): EvidencePacket {
  return {
    proposalId: String(row.proposal_id),
    agent: String(row.agent),
    lane: String(row.lane) as Decision["lane"],
    merchantName: String(row.merchant_name),
    merchantUrl: String(row.merchant_url),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    rationale: String(row.rationale),
    reasonCodes: JSON.parse(String(row.reason_codes)) as string[],
    reasonDetail: String(row.reason_detail),
    citations: JSON.parse(String(row.citations)) as Grounding["citations"],
    mandateId: row.mandate_id === null ? null : String(row.mandate_id),
    txnId: row.txn_id === null ? null : String(row.txn_id),
    settlement: String(row.settlement) as Settlement,
    decidedAt: String(row.decided_at),
    settledAt: row.settled_at === null ? null : String(row.settled_at),
    approvedBy: row.approved_by === null ? null : String(row.approved_by),
  };
}
