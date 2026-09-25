/**
 * Tests for the resumed-conversation kickoff text.
 */

import {
	buildRegisterSelfCommand,
	buildResumedKickoff,
	RESUMED_KICKOFF_MARKER,
} from './resumed-kickoff.js';

describe('buildRegisterSelfCommand', () => {
	it('uses the agent core skill for team members, in the prompt\'s argument order', () => {
		expect(buildRegisterSelfCommand('/opt/crewly', 'team-sam-1', 'developer')).toBe(
			`bash /opt/crewly/config/skills/agent/core/register-self/execute.sh '{"role":"developer","sessionName":"team-sam-1"}'`,
		);
	});

	it('uses the orchestrator skill for the orchestrator', () => {
		expect(buildRegisterSelfCommand('/opt/crewly', 'crewly-orc', 'orchestrator')).toBe(
			`bash /opt/crewly/config/skills/orchestrator/register-self/execute.sh '{"role":"orchestrator","sessionName":"crewly-orc"}'`,
		);
	});
});

describe('buildResumedKickoff', () => {
	it('tells the agent it is the same conversation, to register only, and to carry on', () => {
		const text = buildResumedKickoff({ projectRoot: '/opt/crewly', sessionName: 'team-sam-1', role: 'developer' });
		expect(text.startsWith(RESUMED_KICKOFF_MARKER)).toBe(true);
		expect(text).toContain('Run register-self now (only that step)');
		expect(text).toContain('register-self/execute.sh \'{"role":"developer","sessionName":"team-sam-1"}\'');
		expect(text).toContain('continue exactly where you left off');
		expect(text).toContain('Do not redo your startup steps or re-announce yourself');
		expect(text.endsWith(']')).toBe(true);
		// Not the from-scratch kickoff.
		expect(text).not.toContain('Begin your work now');
		expect(text).not.toContain('Step 1');
		expect(text).not.toContain('\n');
	});

	it('omits the context-refresh pointer when no prompt file is given (Claude Code)', () => {
		const text = buildResumedKickoff({ projectRoot: '/r', sessionName: 's', role: 'developer' });
		expect(text).not.toContain('re-read');
	});

	it('points at the prompt file for a context refresh when given (file-read runtimes)', () => {
		const text = buildResumedKickoff({
			projectRoot: '/r',
			sessionName: 's',
			role: 'developer',
			promptFilePath: '/home/u/.crewly/prompts/s-init.md',
		});
		expect(text).toContain('re-read /home/u/.crewly/prompts/s-init.md.');
	});
});
