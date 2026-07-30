/**
 * Module-resolution hooks that let plain Node ESM load this repo's TypeScript
 * source under `--experimental-strip-types`.
 *
 * The repo uses `moduleResolution: "bundler"` idioms — extensionless relative
 * imports (`./board`) and the `@/*` path alias — which Next.js and `tsc`
 * understand but plain Node does not. These hooks:
 *   - resolve `@/…` to `<root>/src/…`
 *   - append `.ts` / `.tsx` / `/index.ts` to extensionless relative & alias imports
 *
 * Registered by `tests/register-ts.mjs`; see that file / the README for the run
 * command.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function tryFiles(basePath) {
  const candidates = [`${basePath}.ts`, `${basePath}.tsx`, `${basePath}/index.ts`];
  return candidates.find((c) => existsSync(c));
}

export async function resolve(specifier, context, nextResolve) {
  // Alias: @/foo -> <root>/src/foo
  if (specifier.startsWith("@/")) {
    const abs = resolvePath(projectRoot, "src", specifier.slice(2));
    const file = existsSync(abs) ? abs : tryFiles(abs);
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }

  // Extensionless relative imports: ./board -> ./board.ts
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentPath = fileURLToPath(context.parentURL);
    const abs = resolvePath(dirname(parentPath), specifier);
    if (!existsSync(abs)) {
      const file = tryFiles(abs);
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
