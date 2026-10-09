import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createSessionProjectResolver } from './session-projects.js';

function team(dir: string, id: string, body: object): void {
	mkdirSync(path.join(dir, id), { recursive: true });
	writeFileSync(path.join(dir, id, 'config.json'), JSON.stringify(body));
}

describe('createSessionProjectResolver', () => {
	it('returns the project ids of the teams a session is in', () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-'));
		team(dir, 't1', { members: [{ sessionName: 'sam' }], projectIds: ['p-crewly'] });
		team(dir, 't2', { members: [{ agentId: 'sam' }], projectIds: ['p-web'] });
		team(dir, 't3', { members: [{ sessionName: 'vera' }], projectIds: ['p-ce'] });
		const r = createSessionProjectResolver(dir);
		expect(r('sam')?.sort()).toEqual(['p-crewly', 'p-web']);
		expect(r('vera')).toEqual(['p-ce']);
	});
	it('returns null for no team, a missing directory, or no session', () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-'));
		expect(createSessionProjectResolver(dir)('orc')).toBeNull();
		expect(createSessionProjectResolver(path.join(dir, 'nope'))('orc')).toBeNull();
		expect(createSessionProjectResolver(dir)('')).toBeNull();
	});
	it('skips an unreadable team config and reloads after the TTL', () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-'));
		mkdirSync(path.join(dir, 'bad'));
		writeFileSync(path.join(dir, 'bad', 'config.json'), '{nope');
		let t = 0;
		const r = createSessionProjectResolver(dir, () => t);
		expect(r('sam')).toBeNull();
		team(dir, 't1', { members: [{ sessionName: 'sam' }], projectIds: ['p'] });
		expect(r('sam')).toBeNull();
		t = 60_000;
		expect(r('sam')).toEqual(['p']);
	});
});
