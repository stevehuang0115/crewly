/**
 * Readline-backed prompting for CLI wizards, including hidden input.
 *
 * @module cli/utils/prompt-io
 */

import type { Interface as ReadlineInterface } from 'readline';

/** Prompting and output used by the harness setup steps. */
export interface PromptIO {
	ask(question: string): Promise<string>;
	askSecret(question: string): Promise<string>;
	log(line: string): void;
}

/** Readline internals used to mute echo while a secret is typed. */
interface MutableReadline {
	_writeToOutput?: (text: string) => void;
	output?: { write(text: string): void };
}

/**
 * Whether an error is Node's "readline was closed" error, thrown by
 * `rl.question()` when the interface closed before the call.
 *
 * @param error - Anything thrown
 * @returns True for `ERR_USE_AFTER_CLOSE`
 */
export function isReadlineClosedError(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 'ERR_USE_AFTER_CLOSE';
}

/**
 * Ask one question and resolve with the trimmed answer.
 *
 * Closed input rejects with `closedError()` in both cases: when the input
 * closes while the question is pending (EOF), and when it had already closed
 * before the question was asked. In the second case Node's `rl.question()`
 * throws `ERR_USE_AFTER_CLOSE`; an earlier step may have caught the first
 * close and carried on (the login step does), so the next prompt must report
 * closed input too instead of crashing with a stack trace.
 *
 * @param rl - Readline interface
 * @param question - Prompt text
 * @param closedError - Error to reject with when the input is closed
 * @returns The trimmed answer
 * @throws The error from `closedError()` when the input is closed
 */
export function askReadline(rl: ReadlineInterface, question: string, closedError: () => Error): Promise<string> {
	return new Promise((resolve, reject) => {
		const onClose = (): void => reject(closedError());
		rl.on('close', onClose);
		try {
			rl.question(question, (answer) => {
				rl.removeListener('close', onClose);
				resolve(answer.trim());
			});
		} catch (error) {
			rl.removeListener('close', onClose);
			reject(isReadlineClosedError(error) ? closedError() : error);
		}
	});
}

/**
 * Wrap a readline interface as {@link PromptIO}.
 *
 * A pending question rejects when the input closes (EOF), so a wizard reading
 * from an exhausted pipe stops instead of hanging.
 *
 * @param rl - Readline interface
 * @param closedError - Error to reject with when the input closes
 * @param log - Output function (defaults to console.log)
 * @returns Prompt IO
 */
export function createReadlineIO(
	rl: ReadlineInterface,
	closedError: () => Error,
	log: (line: string) => void = (line) => console.log(line),
): PromptIO {
	const ask = (question: string): Promise<string> => askReadline(rl, question, closedError);

	const askSecret = async (question: string): Promise<string> => {
		const mutable = rl as unknown as MutableReadline;
		const original = mutable._writeToOutput;
		let prompted = false;
		// Print the question once, then swallow the echoed keystrokes.
		mutable._writeToOutput = (text: string): void => {
			if (!prompted) {
				prompted = true;
				mutable.output?.write(text);
			}
		};
		try {
			return await ask(question);
		} finally {
			mutable._writeToOutput = original;
			mutable.output?.write('\n');
		}
	};

	return { ask, askSecret, log };
}
