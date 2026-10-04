/**
 * Tests for the credential inventory the guard uses
 * (specs/2026-10-04-agent-credential-isolation.md).
 */

import * as path from 'path';
import { getGuardedCredentialPaths } from './credential-files.js';

describe('getGuardedCredentialPaths', () => {
	it('guards the Cloud directory, the API token, settings.json and the bot-token stores', () => {
		const home = process.env.CREWLY_HOME as string;
		const byPath = new Map(getGuardedCredentialPaths().map((g) => [g.path, g]));
		expect(byPath.get(path.resolve(home, 'cloud'))).toMatchObject({ id: 'cloud-config', isDirectory: true });
		expect(byPath.get(path.resolve(home, 'api-token'))).toMatchObject({ id: 'api-token', isDirectory: false });
		expect(byPath.get(path.resolve(home, 'settings.json'))).toMatchObject({ id: 'settings-api-keys' });
		expect(byPath.get(path.resolve(home, 'harness-credentials.json'))).toMatchObject({ id: 'harness-credentials' });
		expect(byPath.get(path.resolve(home, 'slack-agent-identities.json'))).toBeDefined();
	});

	it('has no duplicate paths and only absolute ones', () => {
		const guarded = getGuardedCredentialPaths();
		expect(new Set(guarded.map((g) => g.path)).size).toBe(guarded.length);
		for (const g of guarded) expect(path.isAbsolute(g.path)).toBe(true);
	});
});
