/**
 * Money is handled as integer minor units throughout the governor.
 *
 * Prava's CLI and REST API both take and return decimal *strings* ("8.50"),
 * never floats — so we parse to integer cents at the boundary, do all
 * comparison and subtraction in integers, and format back to a string only
 * when handing a value to Prava or to a human.
 *
 * Scope: two-decimal currencies only. Zero-decimal (JPY, KRW) and
 * three-decimal (BHD, KWD) currencies are rejected rather than silently
 * mis-scaled — a spend governor that quietly multiplies a cap by 100 is worse
 * than one that refuses the charge.
 */

const TWO_DP = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** Currencies with an exponent other than 2, which `toMinor` refuses. */
const NON_TWO_DP = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "UGX", "RWF", "VUV", "XAF", "XOF", "XPF",
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertSupportedCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MoneyError(`currency must be an ISO 4217 alpha-3 code, got ${JSON.stringify(currency)}`);
  }
  if (NON_TWO_DP.has(currency)) {
    throw new MoneyError(`${currency} is not a two-decimal currency; unsupported by the governor`);
  }
}

/** "8.50" -> 850. Throws on anything that isn't a clean non-negative 2dp decimal. */
export function toMinor(amount: string, currency: string): number {
  assertSupportedCurrency(currency);
  if (typeof amount !== "string" || !TWO_DP.test(amount)) {
    throw new MoneyError(`amount must be a non-negative decimal string with <=2 places, got ${JSON.stringify(amount)}`);
  }
  const [whole, frac = ""] = amount.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 850 -> "8.50". Always two decimal places, which is what Prava expects. */
export function toDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new MoneyError(`minor units must be a non-negative integer, got ${minor}`);
  }
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

/** Human-facing only — never send this to Prava. */
export function format(minor: number, currency: string): string {
  return `${toDecimal(minor)} ${currency}`;
}
