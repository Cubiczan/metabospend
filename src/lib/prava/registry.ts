/**
 * File-backed merchant registry.
 *
 * `GET /v1/mandates` returns `merchantName` but no merchant URL, and our routing
 * matches merchants on hostname — so the URL a mandate was created for has to be
 * remembered locally. The setup script writes it; the demo and the app read it,
 * in a different process, so an in-memory map is not enough.
 *
 * This is a cache, not a source of truth. A missing entry means a `listed`-scope
 * mandate matches nothing, which is the safe direction: it escalates to a person
 * rather than authorizing a charge against a merchant we cannot identify.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { MerchantRegistry } from "./rest";

const DEFAULT_PATH = ".metabospend/mandate-merchants.json";

export class FileMerchantRegistry implements MerchantRegistry {
  private readonly path: string;
  private urls: Record<string, string>;

  constructor(path = process.env.MANDATE_REGISTRY_PATH ?? DEFAULT_PATH) {
    this.path = path;
    this.urls = this.load();
  }

  urlFor(mandateId: string): string | null {
    return this.urls[mandateId] ?? null;
  }

  remember(mandateId: string, merchantUrl: string): void {
    // Re-read first: the setup script and the app may both be writing, and a
    // stale in-memory copy would silently drop the other process's entries.
    this.urls = { ...this.load(), ...this.urls, [mandateId]: merchantUrl };
    this.save();
  }

  all(): Record<string, string> {
    return { ...this.urls };
  }

  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      // Keep only string→string pairs, so a corrupted file degrades to "unknown
      // merchant" rather than injecting a bad URL into a payment decision.
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string" && /^https?:\/\//.test(value)),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated file that
    // would read back as "no mandates have known merchants".
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.urls, null, 2)}\n`, "utf8");
    renameSync(temp, this.path);
  }
}
