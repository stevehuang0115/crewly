import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	buildLiveCheckoutHookCommand,
	codexLiveCheckoutGroup,
	isLiveCheckoutGuardEnabled,
	prepareLiveCheckoutGuard,
	resolveLiveCheckoutRoots,
} from './live-checkout-guard.service.js';
import { buildControlPlaneSettings, resolveControlPlanePaths } from './control-plane-guard.service.js';
import { codexCredentialGuardArgs } from './credential-guard.service.js';

describe('live-checkout guard service', () => {
	let dir: string;
	beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcg-svc-'))); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('is on unless CREWLY_LIVE_CHECKOUT_GUARD=0', () => {
		expect(isLiveCheckoutGuardEnabled({})).toBe(true);
		expect(isLiveCheckoutGuardEnabled({ CREWLY_LIVE_CHECKOUT_GUARD: '1' })).toBe(true);
		expect(isLiveCheckoutGuardEnabled({ CREWLY_LIVE_CHECKOUT_GUARD: '0' })).toBe(false);
		expect(prepareLiveCheckoutGuard(dir, { CREWLY_LIVE_CHECKOUT_GUARD: '0' })).toBeNull();
	});

	it('protects the install root even when it is not a git checkout', () => {
		expect(resolveLiveCheckoutRoots(dir)).toEqual([dir]);
	});

	it('quotes the roots into the hook command', () => {
		const cmd = buildLiveCheckoutHookCommand('/opt/crewly', ['/opt/crewly', "/it's"]);
		expect(cmd).toContain("'/opt/crewly/config/hooks/live-checkout-guard/guard.mjs'");
		expect(cmd).toContain("'/it'\\''s'");
	});

	it('adds a PreToolUse group on Bash and the file-editing tools to the settings', () => {
		const guard = prepareLiveCheckoutGuard(dir)!;
		const settings = buildControlPlaneSettings(
			resolveControlPlanePaths({ crewlyHome: '/h/.crewly', installRoot: dir }), 'bash hook.sh p', undefined, undefined, undefined, guard,
		);
		const group = settings.hooks.PreToolUse.find((g) => g.hooks[0].command === guard.hookCommand)!;
		expect(group.matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit');
		const without = buildControlPlaneSettings(resolveControlPlanePaths({ crewlyHome: '/h/.crewly', installRoot: dir }), 'bash hook.sh p');
		expect(without.hooks.PreToolUse).toHaveLength(1);
	});

	it('protects the guard script itself from agent writes', () => {
		const { writeDenied } = resolveControlPlanePaths({ crewlyHome: '/h/.crewly', installRoot: '/opt/crewly' });
		expect(writeDenied.map((p) => p.path)).toContain('/opt/crewly/config/hooks/live-checkout-guard');
	});

	it('merges into the single Codex hooks.PreToolUse list', () => {
		const group = codexLiveCheckoutGroup(prepareLiveCheckoutGuard(dir)!)!;
		const both = codexCredentialGuardArgs('/h/hook-codex.sh', [group])!;
		expect(both.match(/hooks\.PreToolUse=/g)).toHaveLength(1);
		expect(both).toContain('hook-codex.sh');
		expect(both).toContain('live-checkout-guard/guard.mjs');
		expect(codexCredentialGuardArgs(null, [group])).toContain('live-checkout-guard');
		expect(codexCredentialGuardArgs(null)).toBeNull();
		expect(codexLiveCheckoutGroup({ hookCommand: 'a"b', matcher: 'x', roots: [] })).toBeNull();
	});
});
