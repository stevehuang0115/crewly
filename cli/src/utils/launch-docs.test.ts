/**
 * Launch-copy guard for the OSS docs.
 *
 * Launch copy is npm-global only (Ella + Sam, option A, 2026-09-23):
 * `npm install -g crewly` → `crewly init` → `crewly start`. The npx
 * "try without installing" path returns in Marketing's "Fast follow: npx"
 * (02-distribution-kit.md); when it does, INVERT the npx test below (npx must
 * then appear only as `npx crewly init` followed by `npx crewly start`, never a
 * bare `crewly start` after `npx crewly init`).
 *
 * @module cli/utils/launch-docs.test
 */

import * as fs from 'fs';
import * as path from 'path';

const DOCS = ['README.md', 'docs/getting-started.md', 'docs/demo-flow.md'];

/** Read a repo-root-relative doc. */
function read(rel: string): string {
	return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('launch docs (npm-global only)', () => {
	it(`examines every launch doc (${DOCS.length} files)`, () => {
		// An empty input set is an unknown result, not a pass.
		const found = DOCS.filter((d) => fs.existsSync(path.join(process.cwd(), d)));
		expect(found).toEqual(DOCS);
	});

	it('LAUNCH: no launch doc mentions npx (fast follow: invert when npx returns)', () => {
		const hits = DOCS.flatMap((d) =>
			read(d)
				.split('\n')
				.map((line, i) => ({ d, i: i + 1, line }))
				.filter(({ line }) => /npx/i.test(line))
				.map(({ d, i, line }) => `${d}:${i}: ${line.trim()}`),
		);
		expect(hits).toEqual([]);
	});

	it('README and getting-started show the npm-global primary path', () => {
		for (const d of ['README.md', 'docs/getting-started.md']) {
			const text = read(d);
			expect(text).toContain('npm install -g crewly');
			expect(text).toContain('crewly init');
			expect(text).toContain('crewly start');
		}
	});
});
