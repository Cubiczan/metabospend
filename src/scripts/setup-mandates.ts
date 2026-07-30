/**
 * Create the three mandates MetaboSpend's agents spend against.
 *
 *   npm run setup:mandates
 *
 * Each mandate is a standing authorization the *owner* approves with a passkey —
 * this script only requests them. Nothing is chargeable until you open the
 * approval URL it prints and approve. Run against sandbox (`sk_test_`) unless you
 * genuinely intend to authorize real money.
 *
 * Caps here are deliberately above each agent's auto-execute threshold, so the
 * mandate is the outer limit and our policy the inner one. That ordering is the
 * whole point: the network stops the catastrophic case, our policy stops the
 * merely unwise one.
 */
import { POLICIES, AGENTS } from "../lib/agents/index";
import { format, toMinor } from "../lib/governor/money";
import type { Merchant } from "../lib/governor/types";
import { PravaError } from "../lib/prava/client";
import { FileMerchantRegistry } from "../lib/prava/registry";
import { PravaRestClient } from "../lib/prava/rest";

interface Plan {
  label: string;
  amount: string;
  currency: string;
  merchant?: Merchant;
  frequency: "one_time" | "weekly" | "monthly" | "yearly";
  note: string;
}

const PLANS: Plan[] = [
  {
    label: "Acme Supply — restock",
    amount: "8000.00",
    currency: "USD",
    merchant: { name: "Acme Supply", url: "https://acmesupply.com", country: "US" },
    frequency: "one_time",
    note: "Restock Agent draws POs from this. Cap sits well above its $2,500 threshold.",
  },
  {
    label: "ShipStation — renewal",
    amount: "400.00",
    currency: "USD",
    merchant: { name: "ShipStation", url: "https://shipstation.com", country: "US" },
    frequency: "monthly",
    note: "Recurring, so merchant-locked by design — one charge per period.",
  },
  {
    label: "Ops budget — generic",
    amount: "3000.00",
    currency: "USD",
    frequency: "one_time",
    note: "Generic budget for ad top-ups. Any-scope mandates are one_time and cap at 7 days.",
  },
];

async function main() {
  const registry = new FileMerchantRegistry();
  let client: PravaRestClient;
  try {
    client = new PravaRestClient({ registry });
  } catch (error) {
    if (error instanceof PravaError && error.code === "NO_KEY") {
      console.error(
        "\nPRAVA_SECRET_KEY is not set.\n\n" +
        "  1. Sign in at https://dashboard.prava.space (free sandbox, no payment required)\n" +
        "  2. Copy the sk_test_… secret key\n" +
        "  3. export PRAVA_SECRET_KEY=sk_test_…\n",
      );
      process.exit(1);
    }
    throw error;
  }

  const mode = client.isSandbox ? "SANDBOX — no real money moves" : "LIVE — real money";
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  Requesting ${PLANS.length} mandates · ${mode}`);
  console.log("═".repeat(72));

  if (!client.isSandbox) {
    console.log("\n  ⚠  This is the LIVE API. Each approval below authorizes real spend");
    console.log("     on your real card. Ctrl-C now if that is not what you intend.\n");
  }

  // Show the control pair explicitly — it is the thing reviewers ask about.
  console.log("\n  Agent thresholds (the inner limit):");
  for (const agent of Object.values(AGENTS)) {
    const policy = POLICIES[agent];
    console.log(`    ${agent.padEnd(16)} ${format(toMinor(policy.autoExecuteCap, policy.currency), policy.currency)}`);
  }

  const approvals: Array<{ label: string; url: string | null; id: string }> = [];

  for (const plan of PLANS) {
    process.stdout.write(`\n  ▸ ${plan.label} — ${plan.amount} ${plan.currency} (${plan.frequency})\n`);
    console.log(`    ${plan.note}`);
    try {
      const result = await client.createMandate({
        amount: plan.amount,
        currency: plan.currency,
        merchant: plan.merchant,
        frequency: plan.frequency,
      });
      approvals.push({ label: plan.label, url: result.approvalUrl, id: result.mandateId });
      console.log(`    requested · status ${result.status}`);
    } catch (error) {
      // One failure must not abort the others — a partial set is still useful,
      // and the summary below reports exactly what did and did not get created.
      console.log(`    ✗ failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${"═".repeat(72)}`);
  if (approvals.length === 0) {
    console.log("  No mandates were created. Nothing is authorized.");
    console.log(`${"═".repeat(72)}\n`);
    process.exit(1);
  }

  console.log("  Approve each of these with your passkey — until you do,");
  console.log("  they are pending and cannot be charged:");
  console.log("═".repeat(72));
  for (const approval of approvals) {
    console.log(`\n  ${approval.label}`);
    console.log(`    ${approval.url ?? "(no approval URL returned — check dashboard.prava.space)"}`);
  }

  console.log(`\n  Merchant URLs recorded locally for ${Object.keys(registry.all()).length} mandate(s).`);
  console.log("  (The list endpoint returns only merchantName, so this mapping is");
  console.log("   what lets hostname matching work. Without it, a listed mandate");
  console.log("   matches nothing and every spend escalates to a human.)");
  console.log(`\n  Then: npm run demo:live\n`);
}

await main();
