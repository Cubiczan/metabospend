/**
 * Registers the TypeScript resolution hooks (see ./ts-resolve-hooks.mjs) for
 * the test process. Load it with `--import` so the hooks are active before the
 * test files resolve their imports:
 *
 *   node --test --experimental-strip-types \
 *        --import ./tests/register-ts.mjs "tests/*.test.ts"
 */
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
