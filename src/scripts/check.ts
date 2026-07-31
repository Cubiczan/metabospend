/**
 * Preflight check — run this before demoing anything.
 *
 *   npm run check
 *
 * Read-only: it lists what is configured and what is authorized, and charges
 * nothing. Every line is something that has silently broken a demo before —
 * an unset key, an unapproved mandate, a mandate whose merchant URL was never
 * recorded, an empty grounding corpus.
 */
import { AGENTS, POLICIES } from "../lib/agents/index";
import { format, toMinor } from "../lib/governor/money";
import { PravaError } from "../lib/prava/client";
import { FileMerchantRegistry } from "../lib/prava/registry";
import { PravaRestClient, SANDBOX_BASE_URL } from "../lib/prava/rest";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);

async function main() {
  console.log(`\n${"═".repeat(74)}\n  MetaboSpend preflight\n${"═".repeat(74)}\n`);
  let blocking = 0;

  // ── keys ───────────────────────────────────────────────────────────────────
  const secret = process.env.PRAVA_SECRET_KEY ?? "";
  const baseUrl = process.env.PRAVA_BASE_URL ?? SANDBOX_BASE_URL;

  if (!secret) {
    bad("PRAVA_SECRET_KEY is not set — get an sk_test_ key from dashboard.prava.space");
    blocking++;
  } else if (secret.startsWith("sk_test_")) {
    ok(`sandbox secret key present (…${secret.slice(-6)})`);
  } else if (secret.startsWith("sk_live_")) {
    warn(`LIVE secret key present (…${secret.slice(-6)}) — charges will move real money`);
  } else {
    bad("PRAVA_SECRET_KEY does not look like a Prava key (expected sk_test_ or sk_live_)");
    blocking++;
  }
  console.log(`  · base URL: ${baseUrl}${baseUrl === SANDBOX_BASE_URL ? " (sandbox — no real money)" : " (LIVE)"}`);

  if (process.env.PRAVA_PUBLISHABLE_KEY?.startsWith("sk_")) {
    bad("PRAVA_PUBLISHABLE_KEY holds a SECRET key — that value reaches browsers");
    blocking++;
  }

  // ── mandates ───────────────────────────────────────────────────────────────
  console.log("\n  Mandates");
  const registry = new FileMerchantRegistry();
  if (secret) {
    try {
      const client = new PravaRestClient({ registry });
      const mandates = await client.listMandates();

      if (mandates.length === 0) {
        warn("no active, approved mandates — every spend will escalate to a human");
        console.log("    run `npm run setup:mandates`, then approve each with your passkey");
      }
      for (const mandate of mandates) {
        const scope = mandate.scope === "listed" ? mandate.merchantUrl ?? "UNRESOLVED MERCHANT" : "any merchant";
        const line = `${mandate.id} · ${format(toMinor(mandate.remaining, mandate.currency), mandate.currency)} left · ${scope} · expires ${mandate.validUntil || "unknown"}`;
        // A listed mandate with no recorded URL matches nothing, so it is dead
        // weight rather than spendable authority. Worth saying out loud.
        if (mandate.scope === "listed" && mandate.merchantUrl === null) {
          warn(`${line} — no URL recorded, so this mandate will match nothing`);
        } else if (!mandate.validUntil || Date.parse(mandate.validUntil) <= Date.now()) {
          warn(`${line} — expired or unparseable window, treated as expired`);
        } else {
          ok(line);
        }
      }
    } catch (error) {
      const detail = error instanceof PravaError ? `${error.code}: ${error.message}` : String(error);
      bad(`could not reach Prava — ${detail}`);
      blocking++;
    }
  } else {
    console.log("    skipped (no key)");
  }

  // ── grounding ──────────────────────────────────────────────────────────────
  console.log("\n  Grounding (Senso)");
  if (process.env.SENSO_API_KEY) {
    ok(`SENSO_API_KEY present · corpus "${process.env.SENSO_CORPUS ?? "procurement-policy"}"`);
  } else {
    warn("SENSO_API_KEY not set — the demo falls back to the local policy fixture");
    console.log("    (in production this refuses every grounded agent's spend, by design)");
  }

  // ── the control pair ───────────────────────────────────────────────────────
  console.log("\n  Agent thresholds (inner limit; mandate caps are the outer one)");
  for (const agent of Object.values(AGENTS)) {
    const policy = POLICIES[agent];
    const merchants = policy.allowedMerchants === "any" ? "any merchant" : policy.allowedMerchants.join(", ");
    console.log(`    ${agent.padEnd(15)} ${format(toMinor(policy.autoExecuteCap, policy.currency), policy.currency).padStart(12)}  ${policy.requiresGroundedPolicy ? "grounded" : "ungrounded"}  ${merchants}`);
  }

  console.log(`\n${"═".repeat(74)}`);
  console.log(blocking === 0 ? "  Ready.\n" : `  ${blocking} blocking issue(s) — fix these before demoing.\n`);
  process.exit(blocking === 0 ? 0 : 1);
}

await main();
