/**
 * F-CYCLE7-3-FU replay validation.
 *
 * Source-shape invariants asserted on the merged tree:
 *   1. `isStorageNotReadyError` is now an `instanceof TypeError` +
 *      structural-message classifier — NOT an enumerated method
 *      whitelist. Specifically the source must NOT contain the
 *      whitelist tokens `'filter'|'find'|'map'|'forEach'|'length'`
 *      anymore (those were the brittle list).
 *   2. The classifier signature accepts `error: unknown` (post-fix),
 *      not `message: string` (pre-fix).
 *   3. The two call sites in `getActiveClaims` /
 *      `getAvailablePoolItems` pass the error itself (not a
 *      pre-extracted `msg` string) into the classifier.
 *
 * Pass condition: exits 0 with `[replay] PASS`.
 *
 * Usage (from repo root, post-merge):
 *   node scripts/replay-cycle7-3-fu.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(
	here,
	'..',
	'backend',
	'src',
	'services',
	'reconciler',
	'reconciler-data-provider.ts',
);
const src = readFileSync(sourcePath, 'utf-8');

let failures = 0;
function assert(condition, label, detail) {
	const status = condition ? 'PASS' : 'FAIL';
	if (!condition) failures += 1;
	console.log(`[replay] ${status} — ${label}${detail ? ` (${detail})` : ''}`);
}

// 1. Structural classifier present.
assert(
	/function\s+isStorageNotReadyError\s*\(\s*error:\s*unknown\s*\)/.test(src),
	'isStorageNotReadyError accepts `error: unknown`',
);

// 2. instanceof TypeError narrow present.
assert(
	/error\s+instanceof\s+TypeError/.test(src),
	'classifier narrows on `error instanceof TypeError`',
);

// 3. Structural anchors present (cannot read + of undefined).
assert(
	src.includes("'cannot read'") && src.includes("'of undefined'"),
	'classifier checks both readonly V8 anchors',
);

// 4. Whitelist tokens GONE. Each test searches for the previous
//    `lower.includes("'filter'")`-style whitelist line; any match
//    means the brittle whitelist regressed back in.
const oldWhitelistPatterns = [
	/lower\.includes\(\s*"'filter'"\s*\)/,
	/lower\.includes\(\s*"'find'"\s*\)/,
	/lower\.includes\(\s*"'map'"\s*\)/,
	/lower\.includes\(\s*"'forEach'"\s*\)/,
	/lower\.includes\(\s*"'length'"\s*\)/,
];
for (const pat of oldWhitelistPatterns) {
	assert(!pat.test(src), `whitelist token absent: ${pat.source}`);
}

// 5. Call sites pass the error directly, not a pre-extracted string.
//    The post-fix shape is `if (isStorageNotReadyError(error))` — NOT
//    `if (isStorageNotReadyError(msg))`.
assert(
	src.includes('isStorageNotReadyError(error)'),
	'call sites pass the original error, not a pre-extracted string',
);
assert(
	!/isStorageNotReadyError\(\s*msg\s*\)/.test(src),
	'no leftover msg-string call site',
);

console.log();
if (failures === 0) {
	console.log('[replay] PASS — all source-shape invariants hold');
	process.exit(0);
} else {
	console.error(`[replay] FAIL — ${failures} invariant(s) violated`);
	process.exit(1);
}
