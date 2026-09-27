/**
 * Tests for the readline prompt IO.
 */

import { EventEmitter } from 'events';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { PassThrough } from 'stream';
import { askReadline, createReadlineIO, isReadlineClosedError } from './prompt-io.js';

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

	it('rejects with the closed-input error when the input had already closed (real readline, no ERR_USE_AFTER_CLOSE crash)', async () => {
		const input = new PassThrough();
		const rl = createInterface({ input, output: new PassThrough() });
		const closed = new Promise<void>((resolve) => rl.once('close', () => resolve()));
		input.end();
		await closed;

		const io = createReadlineIO(rl, () => new Error('input closed'));
		await expect(io.ask('First team? ')).rejects.toThrow('input closed');
	});

	it('does not leave a close listener behind when question() throws', async () => {
		const emitter = new EventEmitter();
		const rl = {
			question: () => { throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' }); },
			on: emitter.on.bind(emitter),
			removeListener: emitter.removeListener.bind(emitter),
		};
		await expect(askReadline(rl as unknown as ReadlineInterface, '?', () => new Error('input closed'))).rejects.toThrow('input closed');
		expect(emitter.listenerCount('close')).toBe(0);
	});

	it('passes through other errors thrown by question()', async () => {
		const emitter = new EventEmitter();
		const rl = {
			question: () => { throw new Error('boom'); },
			on: emitter.on.bind(emitter),
			removeListener: emitter.removeListener.bind(emitter),
		};
		await expect(askReadline(rl as unknown as ReadlineInterface, '?', () => new Error('input closed'))).rejects.toThrow('boom');
	});
});

describe('isReadlineClosedError', () => {
	it('is true only for ERR_USE_AFTER_CLOSE', () => {
		expect(isReadlineClosedError(Object.assign(new Error('x'), { code: 'ERR_USE_AFTER_CLOSE' }))).toBe(true);
		expect(isReadlineClosedError(new Error('x'))).toBe(false);
		expect(isReadlineClosedError(null)).toBe(false);
		expect(isReadlineClosedError('ERR_USE_AFTER_CLOSE')).toBe(false);
	});
});
