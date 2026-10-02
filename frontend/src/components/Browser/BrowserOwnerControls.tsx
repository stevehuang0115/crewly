/**
 * BrowserOwnerControls — what the owner types and presses while they hold an
 * agent's browser.
 *
 * Tapping the frame covers clicks; this bar covers the rest of signing in:
 * text into the focused field, the handful of keys a form needs, scrolling,
 * Back, and an address field. It works the same from a desktop and from a
 * phone that opened this dashboard.
 *
 * The text field is sent and cleared in the same step, so what was typed —
 * usually a password — does not stay in component state or on screen.
 *
 * @module components/Browser/BrowserOwnerControls
 */

import React, { useState } from 'react';
import { Button } from '@crewly/ui/Button';
import type { OwnerBrowserInput, OwnerBrowserKey } from '../../services/browser-session.service';

/** How far one scroll button moves the page (CSS px). */
export const OWNER_SCROLL_STEP_PX = 400;

/** Key buttons, in the order shown. */
const KEYS: ReadonlyArray<{ key: OwnerBrowserKey; label: string; title: string }> = [
	{ key: 'Enter', label: 'Enter', title: 'Press Enter' },
	{ key: 'Tab', label: 'Tab', title: 'Press Tab (next field)' },
	{ key: 'Backspace', label: '⌫', title: 'Press Backspace' },
	{ key: 'Escape', label: 'Esc', title: 'Press Escape' },
];

/**
 * Field styling: 16px text so a phone does not zoom the page when the field
 * takes focus.
 */
const FIELD_CLASS =
	'min-w-0 flex-1 px-3 py-2 bg-background-dark border border-border-dark rounded-2xl text-base text-text-primary-dark placeholder:text-text-secondary-dark/50 focus:outline-none focus:ring-1 focus:border-primary focus:ring-primary';

/** Props for {@link BrowserOwnerControls}. */
export interface BrowserOwnerControlsProps {
	/** Carry out one input; resolves to whether it worked */
	onInput: (input: OwnerBrowserInput) => Promise<boolean>;
	/**
	 * Disable the buttons, e.g. while an input is in flight. The text fields
	 * stay usable so a phone keyboard is not dismissed mid-word.
	 */
	disabled?: boolean;
}

/**
 * The owner's control bar.
 *
 * @param props - See {@link BrowserOwnerControlsProps}
 * @returns The control bar
 */
export const BrowserOwnerControls: React.FC<BrowserOwnerControlsProps> = ({ onInput, disabled = false }) => {
	const [text, setText] = useState('');
	const [hidden, setHidden] = useState(false);
	const [url, setUrl] = useState('');

	/** Send the text and clear it in the same step. */
	const sendText = (): void => {
		if (!text) return;
		const toSend = text;
		setText('');
		void onInput({ kind: 'type', text: toSend });
	};

	/** Open the address the owner typed. */
	const go = (): void => {
		const target = url.trim();
		if (!target) return;
		void onInput({ kind: 'navigate', url: target }).then((ok) => {
			if (ok) setUrl('');
		});
	};

	return (
		<div className="mt-3 space-y-2" data-testid="browser-owner-controls">
			<form
				className="flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					sendText();
				}}
			>
				<input
					type={hidden ? 'password' : 'text'}
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="Tap a field on the page, then type here"
					aria-label="Text to type into the page"
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="none"
					spellCheck={false}
					className={FIELD_CLASS}
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setHidden((h) => !h)}
					aria-pressed={hidden}
					title={hidden ? 'Show what you type' : 'Hide what you type (for passwords)'}
				>
					{hidden ? 'Show' : 'Hide'}
				</Button>
				<Button type="submit" size="sm" disabled={disabled || !text}>
					Send
				</Button>
			</form>

			<div className="flex flex-wrap items-center gap-2">
				{KEYS.map(({ key, label, title }) => (
					<Button
						key={key}
						type="button"
						variant="outline"
						size="sm"
						title={title}
						aria-label={title}
						disabled={disabled}
						onClick={() => void onInput({ kind: 'key', key })}
					>
						{label}
					</Button>
				))}
				<Button
					type="button"
					variant="outline"
					size="sm"
					title="Scroll up"
					aria-label="Scroll up"
					disabled={disabled}
					onClick={() => void onInput({ kind: 'scroll', dy: -OWNER_SCROLL_STEP_PX })}
				>
					↑
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					title="Scroll down"
					aria-label="Scroll down"
					disabled={disabled}
					onClick={() => void onInput({ kind: 'scroll', dy: OWNER_SCROLL_STEP_PX })}
				>
					↓
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => void onInput({ kind: 'back' })}
				>
					Back
				</Button>
			</div>

			<form
				className="flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					go();
				}}
			>
				<input
					type="text"
					inputMode="url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="Go to an address"
					aria-label="Address to open"
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="none"
					spellCheck={false}
					className={FIELD_CLASS}
				/>
				<Button type="submit" variant="outline" size="sm" disabled={disabled || !url.trim()}>
					Go
				</Button>
			</form>
		</div>
	);
};
