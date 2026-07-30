/**
 * Senso grounding client — the trust half of the governor.
 *
 * Senso compiles first-party sources (procurement policy, vendor contracts,
 * approved-supplier lists, pricing rules) into a verified, version-controlled
 * knowledge base. We ask it one question per proposal: *does published policy
 * authorize this class of spend, at this amount, with this merchant?*
 *
 * The contract that matters is the failure mode. A grounding lookup that errors,
 * times out, or returns prose without a citation resolves to **not grounded** —
 * never to grounded-by-default. Gate 4 in the governor then refuses the spend for
 * any agent configured to require grounding. An outage makes the system stop
 * spending, not start spending blind.
 */
import type { Grounding, SpendProposal } from "../governor/types";

export interface SensoOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Knowledge base to query. */
  corpus?: string;
}

/** A grounding backend. Swappable so the demo can run offline against fixtures. */
export interface GroundingSource {
  ground(proposal: SpendProposal): Promise<Grounding>;
}

const NOT_GROUNDED: Grounding = { cited: false, citations: [] };

export class SensoClient implements GroundingSource {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly corpus: string;

  constructor(options: SensoOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SENSO_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.SENSO_BASE_URL ?? "https://api.senso.ai").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.corpus = options.corpus ?? process.env.SENSO_CORPUS ?? "procurement-policy";
  }

  async ground(proposal: SpendProposal): Promise<Grounding> {
    if (!this.apiKey) return NOT_GROUNDED;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          corpus: this.corpus,
          query: buildQuery(proposal),
          require_citations: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return NOT_GROUNDED;
      return normalize(await response.json());
    } catch {
      // Timeout, DNS failure, malformed body — all mean "we could not verify".
      return NOT_GROUNDED;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Offline grounding backed by local policy documents. Used by the demo and by
 * tests so the full loop runs with no network and no API key. Rules are matched
 * on agent + merchant host + an amount ceiling, mirroring how a real procurement
 * policy is actually written.
 */
export interface PolicyRule {
  agent: string;
  merchantHost: string | "any";
  maxMinor: number;
  source: string;
  excerpt: string;
}

export class FixtureGroundingSource implements GroundingSource {
  private readonly rules: PolicyRule[];

  constructor(rules: PolicyRule[]) {
    this.rules = rules;
  }

  async ground(proposal: SpendProposal): Promise<Grounding> {
    const host = hostOf(proposal.merchant.url);
    const totalMinor = Math.round(Number(proposal.total) * 100);
    const hit = this.rules.find(
      (rule) =>
        rule.agent === proposal.agent &&
        (rule.merchantHost === "any" || rule.merchantHost === host) &&
        totalMinor <= rule.maxMinor,
    );
    if (!hit) return NOT_GROUNDED;
    return { cited: true, citations: [{ source: hit.source, excerpt: hit.excerpt }] };
  }
}

function buildQuery(proposal: SpendProposal): string {
  return [
    `Does procurement policy authorize the ${proposal.agent} to make a ${proposal.kind}`,
    `of ${proposal.total} ${proposal.currency} from ${proposal.merchant.name} (${proposal.merchant.url})?`,
    `Items: ${proposal.items.map((i) => `${i.quantity}× ${i.description}`).join(", ")}.`,
    "Answer only from published policy and cite the clause.",
  ].join(" ");
}

/** Grounding requires both an affirmative answer and at least one citation. */
function normalize(body: unknown): Grounding {
  if (typeof body !== "object" || body === null) return NOT_GROUNDED;
  const b = body as Record<string, unknown>;
  const rawCitations = Array.isArray(b.citations) ? b.citations : Array.isArray(b.sources) ? b.sources : [];

  const citations = rawCitations
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      source: String(c.title ?? c.source ?? c.document ?? "untitled source"),
      excerpt: String(c.excerpt ?? c.snippet ?? c.text ?? ""),
      url: c.url ? String(c.url) : undefined,
    }))
    .filter((c) => c.excerpt !== "");

  if (citations.length === 0) return NOT_GROUNDED;

  // An explicit negative answer overrides the presence of citations — policy that
  // is cited in order to *refuse* the spend must not be read as authorizing it.
  const answer = String(b.answer ?? b.verdict ?? "").toLowerCase();
  if (/\b(no|not authorized|prohibited|denied)\b/.test(answer)) return NOT_GROUNDED;

  return { cited: true, citations };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
