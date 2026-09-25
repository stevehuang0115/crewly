/**
 * Tests for the readline prompt IO.
 */

import { EventEmitter } from 'events';
import type { Interface as ReadlineInterface } from 'readline';
import { createReadlineIO } from './prompt-io.js';

/**
 * Fake readline answering from a list; records what reached the output.
 *
 * @param answers - Answers in order
 * @returns Fake readline plus the written output
 */
function fakeReadline(answers: string[]) {
	const emitter = new EventEmitter();
	const written: string[] = [];
	const rl = {
		output: { write: (text: string) => written.push(text) },
		_writeToOutput: (text: string) => written.push(text),
		question(prompt: string, cb: (answer: string) => void) {
			(this as { _writeToOutput: (t: string) => void })._writeToOutput(prompt);
			const answer = answers.shift() ?? '';
			// Echo the keystrokes like readline does.
			(this as { _writeToOutput: (t: string) => void })._writeToOutput(answer);
			setImmediate(() => cb(`  ${answer}  `));
		},
		on: emitter.on.bind(emitter),
		removeListener: emitter.removeListener.bind(emitter),
		emit: emitter.emit.bind(emitter),
	};
	return { rl, written };
}

describe('createReadlineIO', () => {
	it('asks and trims the answer', async () => {
		const { rl } = fakeReadline(['codex']);
		const io = createReadlineIO(rl as unknown as ReadlineInterface, () => new Error('closed'));
		expect(await io.ask('Harness? ')).toBe('codex');
	});

	it('askSecret shows the question but not the typed secret, then restores echo', async () => {
		const { rl, written } = fakeReadline(['sk-secret-value', 'visible']);
		const io = createReadlineIO(rl as unknown as ReadlineInterface, () => new Error('closed'));
		expect(await io.askSecret('Key: ')).toBe('sk-secret-value');
		expect(written.join('')).toContain('Key: ');
		expect(written.join('')).not.toContain('sk-secret-value');
		await io.ask('Next: ');
		expect(written.join('')).toContain('visible');
	});

	it('rejects a pending question when the input closes', async () => {
		const emitter = new EventEmitter();
		const rl = { question: jest.fn(), on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) };
		const io = createReadlineIO(rl as unknown as ReadlineInterface, () => new Error('input closed'));
		const pending = io.ask('?');
		emitter.emit('close');
		await expect(pending).rejects.toThrow('input closed');
	});

	it('logs through the given function', () => {
		const log = jest.fn();
		const { rl } = fakeReadline([]);
		createReadlineIO(rl as unknown as ReadlineInterface, () => new Error('x'), log).log('hello');
		expect(log).toHaveBeenCalledWith('hello');
	});
});
