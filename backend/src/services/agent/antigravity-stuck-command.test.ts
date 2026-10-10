import { AntigravityStuckCommandDetector } from './antigravity-stuck-command.js';
import { ANTIGRAVITY_STUCK_COMMAND_CONSTANTS as C } from '../../constants.js';

const SPINNER = '⠋ Running command...\n> ';

function make(children: Record<number, number[]> = { 100: [200] }) {
	const clock = { now: 1_000_000 };
	const logger = { warn: jest.fn() };
	const detector = new AntigravityStuckCommandDetector({ now: () => clock.now, childPids: (pid) => children[pid] ?? [], logger });
	const sendEscape = jest.fn();
	const look = (screen = SPINNER, shellPid: number | null = 100) => detector.observe('s1', { screen, shellPid, sendEscape });
	return { clock, logger, detector, sendEscape, look, children };
}

describe('AntigravityStuckCommandDetector', () => {
	it('sends Escape once the spinner has been there for the threshold and agy has no children', () => {
		const t = make();
		expect(t.look()).toBe(false);
		t.clock.now += C.STUCK_AFTER_MS - 1;
		expect(t.look()).toBe(false);
		t.clock.now += 1;
		expect(t.look()).toBe(true);
		expect(t.sendEscape).toHaveBeenCalledTimes(1);
		expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('sending Escape'), expect.objectContaining({ sessionName: 's1' }));
	});

	it('does nothing while agy still has a child process (a real long command)', () => {
		const t = make({ 100: [200], 200: [300] });
		t.look();
		t.clock.now += C.STUCK_AFTER_MS * 3;
		expect(t.look()).toBe(false);
		expect(t.sendEscape).not.toHaveBeenCalled();
	});

	it('does nothing when agy cannot be found under the shell, or the pid is unknown', () => {
		const t = make({});
		t.look();
		t.clock.now += C.STUCK_AFTER_MS;
		expect(t.look()).toBe(false);
		expect(make().look(SPINNER, null)).toBe(false);
	});

	it('restarts the timer when the spinner goes away', () => {
		const t = make();
		t.look();
		t.clock.now += C.STUCK_AFTER_MS - 1000;
		t.look('> ready');
		t.clock.now += 2000;
		expect(t.look()).toBe(false);
		t.clock.now += C.STUCK_AFTER_MS;
		expect(t.look()).toBe(true);
	});

	it('does not repeat within the cooldown, then can again', () => {
		const t = make();
		t.look();
		t.clock.now += C.STUCK_AFTER_MS;
		expect(t.look()).toBe(true);
		t.clock.now += C.REPEAT_COOLDOWN_MS - 1;
		expect(t.look()).toBe(false);
		t.clock.now += C.STUCK_AFTER_MS + 1;
		expect(t.look()).toBe(true);
		expect(t.sendEscape).toHaveBeenCalledTimes(2);
	});
});
