/**
 * An in-process Prava double.
 *
 * It exists so the whole loop — propose, route, charge, settle, report — can run
 * in tests and in the demo with no CLI, no network, and no card. It models the
 * behaviours that actually change our control flow:
 *
 *  - mandate balances that deplete as they are charged
 *  - `THRESHOLD_EXCEEDED` declines when a charge exceeds the remaining balance
 *  - a settlement report that must arrive for the charge to be considered closed
 *
 * It is not a simulator of Visa. It is a fixture with teeth: if our code forgets
 * to report a charge, `unreportedCharges()` says so and a test fails.
 */
import { toDecimal, toMinor } from "../governor/money";
import type { Mandate } from "../governor/types";
import { PravaError, type PaymentCredential, type PravaGateway, type SessionHandle } from "./client";

export interface SandboxOptions {
  mandates: Mandate[];
  /** Force every charge to decline, to exercise the decline path. */
  declineAll?: boolean;
  /** Throw on charge, to exercise the failure path. */
  throwOnCharge?: boolean;
}

export class SandboxPrava implements PravaGateway {
  private mandates: Mandate[];
  private counter = 0;
  private readonly charges = new Map<string, { mandateId: string; reported: boolean }>();
  private readonly options: SandboxOptions;
  readonly sessions: SessionHandle[] = [];

  constructor(options: SandboxOptions) {
    this.options = options;
    this.mandates = options.mandates.map((m) => ({ ...m }));
  }

  async listMandates(): Promise<Mandate[]> {
    return this.mandates.map((m) => ({ ...m }));
  }

  async chargeMandate(args: { mandateId: string; amount: string; reference?: string }) {
    if (this.options.throwOnCharge) {
      throw new PravaError("sandbox: network unreachable", "CLI_FAILED", 1);
    }

    const mandate = this.mandates.find((m) => m.id === args.mandateId);
    if (!mandate) {
      return { ok: false as const, declineCode: "MANDATE_NOT_FOUND", detail: `no mandate ${args.mandateId}` };
    }

    const amountMinor = toMinor(args.amount, mandate.currency);
    const remainingMinor = toMinor(mandate.remaining, mandate.currency);

    // The server is the authority on the cap, so this decline is a normal
    // outcome even when our own screening thought there was room.
    if (this.options.declineAll || amountMinor > remainingMinor) {
      return {
        ok: false as const,
        declineCode: "THRESHOLD_EXCEEDED",
        detail: `charge of ${args.amount} exceeds remaining ${mandate.remaining}`,
      };
    }

    mandate.remaining = toDecimal(remainingMinor - amountMinor);
    const txnId = `txn_sandbox_${++this.counter}`;
    this.charges.set(txnId, { mandateId: mandate.id, reported: false });

    return {
      ok: true as const,
      credential: {
        // Visa test-range network token. Single-use — never persisted.
        token: "4323126882557932",
        cryptogram: String(100 + (this.counter % 900)),
        expiryMonth: "12",
        expiryYear: "2027",
        txnId,
      } satisfies PaymentCredential,
    };
  }

  async reportMandateCharge(args: { mandateId: string; txnId: string; status: "APPROVED" | "DECLINED" }): Promise<void> {
    const charge = this.charges.get(args.txnId);
    if (!charge) throw new PravaError(`sandbox: unknown txn ${args.txnId}`, "CLI_FAILED", 1);
    charge.reported = true;
  }

  async createSession(args: { total: string; currency: string }): Promise<SessionHandle> {
    const sessionId = `sess_sandbox${++this.counter}`;
    const handle = {
      sessionId,
      paymentUrl: `https://pay.prava.space/s/${sessionId}?amount=${args.total}&currency=${args.currency}`,
    };
    this.sessions.push(handle);
    return handle;
  }

  async pollSession(sessionId: string): Promise<PaymentCredential> {
    const txnId = `txn_${sessionId}`;
    this.charges.set(txnId, { mandateId: "session", reported: true });
    return {
      token: "4323126882557932",
      cryptogram: "914",
      expiryMonth: "12",
      expiryYear: "2027",
      txnId,
    };
  }

  /** Any successful charge we never settled. Should always be empty. */
  unreportedCharges(): string[] {
    return [...this.charges.entries()].filter(([, c]) => !c.reported).map(([txnId]) => txnId);
  }

  remainingOf(mandateId: string): string {
    return this.mandates.find((m) => m.id === mandateId)?.remaining ?? "0.00";
  }
}
