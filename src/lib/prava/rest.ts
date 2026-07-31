/**
 * REST implementation of the payment surface, against Prava's sandbox.
 *
 * The CLI (`./client.ts`) runs against the live API only — there is no test mode
 * for Prava Pay. The REST API does have one: `sandbox.api.prava.space` with
 * `sk_test_` keys, where no real money moves and the card network runs in test
 * mode. That is what this client is for: a real mandate, a real charge, a real
 * transaction id, and no real money — so the demo can be rehearsed freely.
 *
 * It implements the same `PravaGateway` interface as the CLI client and the
 * offline sandbox, so nothing in the governor, ledger, or agents changes.
 *
 * ## The merchant-URL problem
 *
 * `GET /v1/mandates` returns `merchantName` but no merchant URL, while our
 * routing matches merchants on hostname — a display name is far too weak a thing
 * to authorize a payment against ("Acme Supply" could be anyone). So we keep a
 * local registry of the URL each mandate was created for, and a `listed`-scope
 * mandate whose URL we cannot resolve is returned with `merchantUrl: null`, which
 * makes it match nothing. Deny-first, consistent with the rest of the governor.
 */
import { toDecimal } from "../governor/money";
import type { LineItem, Mandate, Merchant } from "../governor/types";
import { PravaError, type PaymentCredential, type PravaGateway, type SessionHandle } from "./client";

export const SANDBOX_BASE_URL = "https://sandbox.api.prava.space";
export const LIVE_BASE_URL = "https://api.prava.space";

/** Resolves a mandate id to the merchant URL it was authorized for. */
export interface MerchantRegistry {
  urlFor(mandateId: string): string | null;
  remember(mandateId: string, merchantUrl: string): void;
}

/** In-memory registry. Swap for the ledger-backed one to survive a restart. */
export class InMemoryMerchantRegistry implements MerchantRegistry {
  private readonly urls = new Map<string, string>();
  urlFor(mandateId: string): string | null {
    return this.urls.get(mandateId) ?? null;
  }
  remember(mandateId: string, merchantUrl: string): void {
    this.urls.set(mandateId, merchantUrl);
  }
}

export interface PravaRestOptions {
  /** `sk_test_…` for sandbox. Server-side only — never expose this to a browser. */
  secretKey?: string;
  baseUrl?: string;
  registry?: MerchantRegistry;
  timeoutMs?: number;
  /** Identifies the payer on session creation. */
  customer?: { id: string; email: string };
}

export class PravaRestClient implements PravaGateway {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly customer: { id: string; email: string };
  readonly registry: MerchantRegistry;

  constructor(options: PravaRestOptions = {}) {
    const key = options.secretKey ?? process.env.PRAVA_SECRET_KEY ?? "";
    if (!key) {
      throw new PravaError("PRAVA_SECRET_KEY is not set — get an sk_test_ key from dashboard.prava.space", "NO_KEY", null);
    }
    // A live key reaching a sandbox-intended run would move real money. Refuse
    // the ambiguity rather than resolve it silently.
    const baseUrl = (options.baseUrl ?? process.env.PRAVA_BASE_URL ?? SANDBOX_BASE_URL).replace(/\/$/, "");
    if (key.startsWith("sk_live_") && baseUrl === SANDBOX_BASE_URL) {
      throw new PravaError("a live secret key was given with the sandbox base URL — set PRAVA_BASE_URL explicitly to go live", "KEY_ENV_MISMATCH", null);
    }
    if (key.startsWith("sk_test_") && baseUrl === LIVE_BASE_URL) {
      throw new PravaError("a test secret key cannot be used against the live API", "KEY_ENV_MISMATCH", null);
    }

    this.secretKey = key;
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.registry = options.registry ?? new InMemoryMerchantRegistry();
    this.customer = options.customer ?? {
      id: process.env.PRAVA_CUSTOMER_ID ?? "metabospend-ops",
      email: process.env.PRAVA_CUSTOMER_EMAIL ?? "ops@metabospend.local",
    };
  }

  get isSandbox(): boolean {
    return this.baseUrl === SANDBOX_BASE_URL;
  }

  /**
   * Create a standing authorization. Returns the mandate plus the URL the owner
   * approves with a passkey — until they do, it is `pending` and cannot be charged.
   */
  async createMandate(args: {
    amount: string;
    currency: string;
    merchant?: Merchant;
    frequency?: Mandate["frequency"];
    validUntil?: string;
  }): Promise<{ mandateId: string; approvalUrl: string | null; status: string }> {
    const scope = args.merchant ? "listed" : "any";
    const body: Record<string, unknown> = {
      amount: args.amount,
      currency: args.currency,
      merchant_scope: scope,
      recurring_frequency: args.frequency ?? "one_time",
      customer_id: this.customer.id,
    };
    if (args.merchant) {
      body.merchant_name = args.merchant.name;
      body.merchant_url = args.merchant.url;
      body.merchant_country = args.merchant.country;
    }
    if (args.validUntil) body.valid_until = args.validUntil;

    const result = await this.request<Record<string, unknown>>("POST", "/v1/mandates", body);
    const mandateId = String(result.id ?? result.mandateId ?? "");
    if (!mandateId) throw new PravaError("mandate creation returned no id", "PARSE_FAILED", null);

    // Remember the URL now, while we still know it — the list endpoint won't tell us.
    if (args.merchant) this.registry.remember(mandateId, args.merchant.url);

    return {
      mandateId,
      approvalUrl: firstUrl(result.approval_url ?? result.approvalUrl ?? result.url),
      status: String(result.status ?? "pending"),
    };
  }

  /**
   * Only mandates that are both `active` and usable are returned. A paused,
   * consumed, expired, or still-pending mandate is not something to spend against,
   * so it is filtered out here rather than relied on to fail later.
   */
  async listMandates(): Promise<Mandate[]> {
    // A customer only exists once a session or mandate has been created for it,
    // so filtering by one that has never transacted returns CUSTOMER_NOT_FOUND.
    // That means "no mandates", not "something is broken" — and it is the state
    // every fresh sandbox account starts in.
    const body = await this.request<Record<string, unknown>>(
      "GET",
      `/v1/mandates?customer_id=${encodeURIComponent(this.customer.id)}&standing_only=true`,
      undefined,
      { allowStatus: [404] },
    );
    if (errorCodeOf(body) === "CUSTOMER_NOT_FOUND") return [];

    const rows = Array.isArray(body.mandates) ? body.mandates : Array.isArray(body) ? body : [];

    return rows
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .filter((row) => String(row.status).toLowerCase() === "active")
      .filter((row) => {
        const state = String(row.state ?? "available").toLowerCase();
        return state === "available";
      })
      .map((row) => {
        const id = String(row.id ?? "");
        const scope = String(row.merchantScope ?? row.merchant_scope ?? "listed") === "any" ? "any" as const : "listed" as const;
        return {
          id,
          scope,
          // Never inferred from merchantName — an unresolvable URL matches nothing.
          merchantUrl: scope === "listed" ? this.registry.urlFor(id) : null,
          remaining: String(row.remaining ?? row.approvedAmount ?? "0.00"),
          currency: String(row.currency ?? "USD").toUpperCase(),
          validUntil: String(row.validUntil ?? row.valid_until ?? ""),
          frequency: normalizeFrequency(row.recurringFrequency ?? row.recurring_frequency),
        } satisfies Mandate;
      })
      .filter((mandate) => mandate.id !== "");
  }

  async chargeMandate(args: { mandateId: string; amount: string; reference?: string }) {
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/v1/mandates/${encodeURIComponent(args.mandateId)}/charge`,
      { amount: args.amount, ...(args.reference ? { reference: args.reference } : {}) },
      { allowStatus: [402, 409] },
    );

    const status = String(result.status ?? "").toLowerCase();
    const credentials = result.credentials as Record<string, unknown> | undefined;

    if (status === "failed" || !credentials) {
      return {
        ok: false as const,
        declineCode: String(result.errorCode ?? result.error_code ?? "DECLINED"),
        detail: String(result.errorMessage ?? result.error_message ?? "mandate charge declined"),
      };
    }

    return {
      ok: true as const,
      credential: {
        token: String(credentials.token ?? ""),
        cryptogram: String(credentials.dynamicCvv ?? credentials.dynamic_cvv ?? ""),
        expiryMonth: String(credentials.expiryMonth ?? credentials.expiry_month ?? ""),
        expiryYear: String(credentials.expiryYear ?? credentials.expiry_year ?? ""),
        txnId: String(result.transactionId ?? result.transaction_id ?? ""),
      } satisfies PaymentCredential,
    };
  }

  async reportMandateCharge(args: { mandateId: string; txnId: string; status: "APPROVED" | "DECLINED" }): Promise<void> {
    await this.request(
      "POST",
      `/v1/mandates/${encodeURIComponent(args.mandateId)}/charges/${encodeURIComponent(args.txnId)}/report`,
      { status: args.status, type: "PURCHASE" },
    );
  }

  async createSession(args: { total: string; currency: string; merchant: Merchant; items: LineItem[] }): Promise<SessionHandle> {
    // Field names verified against the API's own validator, not the prose docs:
    // it requires `total_amount` (not `amount`), and product lines take
    // `unit_price` (not `amount`). Sending the guide's names returns VAL_2001.
    const result = await this.request<Record<string, unknown>>("POST", "/v1/sessions", {
      user_id: this.customer.id,
      user_email: this.customer.email,
      total_amount: args.total,
      currency: args.currency,
      description: `MetaboSpend — ${args.merchant.name}`,
      purchase_context: [{
        merchant_details: {
          name: args.merchant.name,
          url: args.merchant.url,
          country_code_iso2: args.merchant.country,
        },
        product_details: args.items.map((item) => ({
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
        })),
        effective_until_minutes: 15,
      }],
    });

    const sessionId = String(result.session_id ?? result.sessionId ?? "");
    const iframeUrl = firstUrl(result.iframe_url ?? result.iframeUrl);
    if (!sessionId || !iframeUrl) {
      throw new PravaError("session creation returned no id or card-form URL", "PARSE_FAILED", null);
    }
    return { sessionId, paymentUrl: iframeUrl };
  }

  /**
   * Poll until the person has completed the card form and passkey. Prava sessions
   * expire in ~15 minutes, so polling is bounded well inside that.
   */
  async pollSession(sessionId: string, options: { attempts?: number; intervalMs?: number } = {}): Promise<PaymentCredential> {
    const attempts = options.attempts ?? 100;
    const intervalMs = options.intervalMs ?? 3_000;

    for (let attempt = 0; attempt < attempts; attempt++) {
      // The cache-buster is not superstition: without it Next.js and other fetch
      // layers dedupe the identical polling request and hand back a stale
      // "pending" forever.
      const body = await this.request<Record<string, unknown>>(
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionId)}/payment-result?_t=${attempt}-${process.hrtime.bigint()}`,
      );
      const status = String(body.status ?? "").toLowerCase();
      const txn = (Array.isArray(body.transactions) ? body.transactions[0] : undefined) as Record<string, unknown> | undefined;

      if (status === "completed" && txn) {
        // Credentials live on the transaction's *line item*, not the transaction
        // itself — reading txn.token directly yields undefined and a silent
        // "no credential" failure.
        const line = (Array.isArray(txn.line_items) ? txn.line_items[0] : undefined) as Record<string, unknown> | undefined;
        const source = line ?? txn;
        return {
          token: String(source.token ?? ""),
          cryptogram: String(source.dynamic_cvv ?? source.dynamicCvv ?? ""),
          expiryMonth: String(source.expiry_month ?? source.expiryMonth ?? ""),
          expiryYear: String(source.expiry_year ?? source.expiryYear ?? ""),
          txnId: String(txn.txn_id ?? txn.txnId ?? sessionId),
        };
      }
      if (status === "failed") {
        const error = txn?.error as Record<string, unknown> | undefined;
        throw new PravaError(String(error?.message ?? "payment failed"), "PAYMENT_FAILED", null);
      }
      await sleep(intervalMs);
    }
    throw new PravaError(`session ${sessionId} did not complete within the polling window`, "POLL_TIMEOUT", null);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { allowStatus?: number[] } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = text ? safeJson(text) : {};

      if (!response.ok && !(options.allowStatus ?? []).includes(response.status)) {
        throw new PravaError(
          `${method} ${path} → ${response.status}: ${describeError(parsed, text)}`,
          errorCodeOf(parsed) ?? `HTTP_${response.status}`,
          null,
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof PravaError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PravaError(`${method} ${path} timed out after ${this.timeoutMs}ms`, "TIMEOUT", null);
      }
      throw new PravaError(`${method} ${path} failed: ${(error as Error).message}`, "NETWORK", null);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Prava nests its errors as `{ error: { code, message } }`, so reading `.message`
 * or `.error` off the top level yields "[object Object]" and throws away the one
 * piece of information worth having.
 */
function errorCodeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const nested = b.error;
  if (typeof nested === "object" && nested !== null) {
    const code = (nested as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return typeof b.code === "string" ? b.code : null;
}

function describeError(body: unknown, raw: string): string {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const nested = b.error;
    if (typeof nested === "object" && nested !== null) {
      const { code, message } = nested as Record<string, unknown>;
      if (typeof message === "string") return code ? `${String(code)}: ${message}` : message;
    }
    if (typeof nested === "string") return nested;
    if (typeof b.message === "string") return b.message;
  }
  return raw.slice(0, 300);
}

function normalizeFrequency(raw: unknown): Mandate["frequency"] {
  const value = String(raw ?? "one_time");
  return (["one_time", "weekly", "monthly", "yearly"] as const).find((f) => f === value) ?? "one_time";
}

function firstUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value : "";
  return /^https?:\/\//.test(text) ? text : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
