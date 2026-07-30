/**
 * Server-only wrapper around the Prava CLI (`@prava-sdk/cli`).
 *
 * Why the CLI rather than REST: the CLI holds the agent's keypair locally and
 * handles the link/approval handshake itself, so this process never sees a card
 * number, an API secret, or a passkey. We shell out and parse `--json`.
 *
 * Two rules this module enforces, because they are the ones that matter:
 *
 *  1. **Never mint before a human-visible confirmation.** `createSession` is the
 *     only path that produces a passkey URL, and the governor only reaches it
 *     via the approval lane. `chargeMandate` skips the passkey precisely because
 *     the mandate's setup passkey already was the consent.
 *  2. **Always report the outcome.** A mandate charge that is never reported
 *     leaves the network holding an open authorization. `chargeMandate` callers
 *     must follow with `reportMandateCharge` — see `settle()` in ../governor/execute.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LineItem, Mandate, Merchant } from "../governor/types";

const run = promisify(execFile);

/** Credentials are single-use and expire in ~30 minutes. Never log or persist them. */
export interface PaymentCredential {
  /** 16-digit Visa network token — goes in the card-number field. */
  token: string;
  /** Single-use dynamic CVV. */
  cryptogram: string;
  expiryMonth: string;
  expiryYear: string;
  txnId: string;
}

export interface SessionHandle {
  sessionId: string;
  /** Show this to the person; they approve with a passkey. */
  paymentUrl: string;
}

/**
 * The payment surface the governor depends on.
 *
 * Extracted as an interface so the demo and the tests can drive the full loop
 * against a sandbox double without shelling out to a real CLI or touching a real
 * card. `PravaClient` is the only implementation that moves money.
 */
export interface PravaGateway {
  listMandates(): Promise<Mandate[]>;
  chargeMandate(args: { mandateId: string; amount: string; reference?: string }): Promise<
    { ok: true; credential: PaymentCredential } | { ok: false; declineCode: string; detail: string }
  >;
  reportMandateCharge(args: { mandateId: string; txnId: string; status: "APPROVED" | "DECLINED" }): Promise<void>;
  createSession(args: { total: string; currency: string; merchant: Merchant; items: LineItem[] }): Promise<SessionHandle>;
  pollSession(sessionId: string): Promise<PaymentCredential>;
}

export class PravaError extends Error {
  readonly code: string;
  readonly exitCode: number | null;

  constructor(message: string, code: string, exitCode: number | null) {
    super(message);
    this.name = "PravaError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface PravaClientOptions {
  /** Absolute path to the `prava` binary. Agent shells often lack nvm/brew paths. */
  bin?: string;
  timeoutMs?: number;
}

export class PravaClient implements PravaGateway {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: PravaClientOptions = {}) {
    this.bin = options.bin ?? process.env.PRAVA_BIN ?? "prava";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Link state: "active" | "pending" | "expired" | "unconfigured". */
  async status(): Promise<{ state: string; linkUrl: string | null }> {
    const { stdout } = await this.exec(["status"], { allowExitCode: 2 });
    const state = /\bactive\b/i.test(stdout)
      ? "active"
      : /\bpending\b/i.test(stdout)
        ? "pending"
        : /link expired/i.test(stdout)
          ? "expired"
          : "unconfigured";
    const linkUrl = stdout.match(/Link:\s*(\S+)/)?.[1] ?? null;
    return { state, linkUrl };
  }

  /** Normalized `prava mandate list --json`. Shapes vary across CLI versions. */
  async listMandates(): Promise<Mandate[]> {
    const raw = await this.execJson<unknown>(["mandate", "list", "--json"]);
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { mandates?: unknown[] })?.mandates)
        ? (raw as { mandates: unknown[] }).mandates
        : [];
    return rows.map(normalizeMandate).filter((m): m is Mandate => m !== null);
  }

  /**
   * Charge an existing mandate. No passkey — the mandate's setup approval was
   * the consent. A `status: "failed"` result (e.g. THRESHOLD_EXCEEDED) is a
   * normal network decline to relay, not an exception to swallow.
   */
  async chargeMandate(args: {
    mandateId: string;
    amount: string;
    reference?: string;
  }): Promise<{ ok: true; credential: PaymentCredential } | { ok: false; declineCode: string; detail: string }> {
    const argv = ["mandate", "charge", "--mandate-id", args.mandateId, "--amount", args.amount, "-y"];
    if (args.reference) argv.push("--reference", args.reference);

    const result = await this.execJson<Record<string, unknown>>(argv, { allowExitCode: 1 });
    if (String(result.status).toLowerCase() === "failed") {
      return {
        ok: false,
        declineCode: String(result.error_code ?? result.code ?? "DECLINED"),
        detail: String(result.message ?? result.error ?? "mandate charge declined"),
      };
    }
    return { ok: true, credential: normalizeCredential(result) };
  }

  /**
   * Settle a mandate charge with the card network. Must be called after every
   * successful charge, whether the merchant checkout succeeded or not.
   */
  async reportMandateCharge(args: {
    mandateId: string;
    txnId: string;
    status: "APPROVED" | "DECLINED";
  }): Promise<void> {
    await this.exec([
      "mandate", "report",
      "--mandate-id", args.mandateId,
      "--txn-id", args.txnId,
      "--status", args.status,
    ]);
  }

  /**
   * Mint a payment session. Returns a URL the person approves with a passkey.
   * Only ever called from the approval lane, after a human has said yes.
   */
  async createSession(args: {
    total: string;
    currency: string;
    merchant: Merchant;
    items: LineItem[];
  }): Promise<SessionHandle> {
    const argv = [
      "sessions", "create",
      "--total-amount", args.total,
      "--currency", args.currency,
      "--merchant-name", args.merchant.name,
      "--merchant-url", args.merchant.url,
      "--merchant-country", args.merchant.country,
    ];
    for (const item of args.items) {
      argv.push("--product", JSON.stringify({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      }));
    }
    const { stdout } = await this.exec(argv);
    const paymentUrl = stdout.match(/https?:\/\/\S+/)?.[0];
    const sessionId = stdout.match(/\bsess_[A-Za-z0-9]+/)?.[0];
    if (!paymentUrl || !sessionId) {
      throw new PravaError(`could not parse session from CLI output: ${stdout.slice(0, 400)}`, "PARSE_FAILED", 0);
    }
    return { sessionId, paymentUrl };
  }

  /** Block until the person approves in the browser (CLI polls up to ~10 min). */
  async pollSession(sessionId: string): Promise<PaymentCredential> {
    const result = await this.execJson<Record<string, unknown>>(
      ["sessions", "poll", "--session-id", sessionId],
      { timeoutMs: 11 * 60_000 },
    );
    return normalizeCredential(result);
  }

  private async exec(
    argv: string[],
    options: { allowExitCode?: number; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await run(this.bin, argv, {
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      // `execFile` rejections carry the spawn error string ("ENOENT") *or* a
      // numeric exit code in the same `code` field, so it is read as a union
      // rather than as ErrnoException's `string`.
      const err = error as {
        code?: number | string;
        message?: string;
        stdout?: string;
        stderr?: string;
      };
      const exitCode = typeof err.code === "number" ? err.code : null;

      // Exit codes the caller wants to inspect rather than throw on.
      if (exitCode !== null && exitCode === options.allowExitCode) {
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
      }
      if (err.code === "ENOENT") {
        throw new PravaError(
          "the prava CLI was not found — install it with `npm install -g @prava-sdk/cli`, or set PRAVA_BIN to its absolute path",
          "CLI_NOT_FOUND",
          null,
        );
      }
      if (exitCode === 2) {
        throw new PravaError("this agent is not linked to a Prava account — run `prava setup`", "NOT_LINKED", 2);
      }
      const detail = (err.stderr || err.stdout || err.message || "").trim();
      throw new PravaError(detail || "prava CLI failed", "CLI_FAILED", exitCode);
    }
  }

  private async execJson<T>(
    argv: string[],
    options: { allowExitCode?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const { stdout } = await this.exec(argv, options);
    // The CLI prints human-readable text around JSON on some commands, so take
    // the outermost JSON value rather than assuming the whole stream parses.
    const start = stdout.search(/[[{]/);
    const end = Math.max(stdout.lastIndexOf("]"), stdout.lastIndexOf("}"));
    if (start === -1 || end <= start) {
      throw new PravaError(`expected JSON from \`prava ${argv.join(" ")}\`, got: ${stdout.slice(0, 400)}`, "PARSE_FAILED", 0);
    }
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as T;
    } catch (error) {
      throw new PravaError(`malformed JSON from \`prava ${argv.join(" ")}\`: ${(error as Error).message}`, "PARSE_FAILED", 0);
    }
  }
}

function normalizeCredential(row: Record<string, unknown>): PaymentCredential {
  const token = row.token ?? row.card_number;
  const cryptogram = row.cryptogram ?? row.dynamic_cvv ?? row.cvv;
  if (!token || !cryptogram) {
    throw new PravaError("payment result contained no usable credential", "NO_CREDENTIAL", 0);
  }
  return {
    token: String(token),
    cryptogram: String(cryptogram),
    expiryMonth: String(row.expiry_month ?? row.expiryMonth ?? ""),
    expiryYear: String(row.expiry_year ?? row.expiryYear ?? ""),
    txnId: String(row.txn_id ?? row.txnId ?? ""),
  };
}

/** Returns null for rows we cannot read, so an unparseable mandate is never treated as spendable. */
function normalizeMandate(row: unknown): Mandate | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = r.id ?? r.mandate_id;
  if (!id) return null;
  const scope = r.scope === "any" ? "any" : "listed";
  const rawFrequency = String(r.recurring_frequency ?? r.frequency ?? "one_time");
  const frequency = (["one_time", "weekly", "monthly", "yearly"] as const)
    .find((f) => f === rawFrequency) ?? "one_time";
  return {
    id: String(id),
    scope,
    merchantUrl: scope === "listed" ? (r.merchant_url ? String(r.merchant_url) : null) : null,
    remaining: String(r.remaining ?? r.remaining_amount ?? "0.00"),
    currency: String(r.currency ?? "USD").toUpperCase(),
    validUntil: String(r.valid_until ?? r.expires_at ?? ""),
    frequency,
  };
}
