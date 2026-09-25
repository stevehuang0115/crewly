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
	const ask = (question: string): Promise<string> =>
		new Promise((resolve, reject) => {
			const onClose = (): void => reject(closedError());
			rl.on('close', onClose);
			rl.question(question, (answer) => {
				rl.removeListener('close', onClose);
				resolve(answer.trim());
			});
		});

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
