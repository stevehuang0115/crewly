/**
 * One-line hints for files that arrive with a chat message.
 *
 * A Slack voice message reaches the agent as `[Slack File: /…/F123-Audio_Clip.m4a
 * (audio/mp4, 214KB)]`. One agent knew to run `transcribe-audio`; another said
 * "I can't transcribe audio" and stopped. The path alone does not say which
 * skill reads the file, so the bridge adds a hint naming it — and what to do
 * when that skill is not set up yet (specs/skill-auto-install.md).
 *
 * PDFs already get their text extracted inline by the Slack bridge; a hint is
 * added only when that extraction failed or was cut short, so the agent is not
 * told twice about content it already has.
 *
 * @module utils/inbound-file-hint.utils
 */

/** File extensions treated as audio/video even when the MIME type is generic. */
export const AUDIO_VIDEO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'amr', 'webm', 'mp4', 'm4v', 'mov', 'mkv', 'caf'] as const;

/** Marker the Slack bridge appends when it cuts extracted PDF text. */
export const EXTRACTED_TEXT_TRUNCATED_MARKER = '[truncated]';

/** The fields of an inbound file the hint needs. */
export interface InboundFile {
	name: string;
	mimetype: string;
	localPath: string;
	/** Text already extracted inline (PDFs) */
	extractedText?: string;
}

/**
 * The file extension, lower-cased.
 *
 * @param name - File name
 * @returns Extension without the dot ('' when none)
 */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Whether a file is audio or video.
 *
 * @param file - Inbound file
 * @returns True for audio/* or video/* MIME types or a known extension
 */
export function isAudioOrVideo(file: Pick<InboundFile, 'name' | 'mimetype'>): boolean {
	const mime = (file.mimetype ?? '').toLowerCase();
	if (mime.startsWith('audio/') || mime.startsWith('video/')) return true;
	return (AUDIO_VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(file.name ?? ''));
}

/**
 * Whether a file is a PDF.
 *
 * @param file - Inbound file
 * @returns True for application/pdf or a .pdf name
 */
export function isPdf(file: Pick<InboundFile, 'name' | 'mimetype'>): boolean {
	return (file.mimetype ?? '').toLowerCase() === 'application/pdf' || extensionOf(file.name ?? '') === 'pdf';
}

/**
 * The hint line for one inbound file, or null when none is needed.
 *
 * @param file - Inbound file
 * @returns e.g. `[Hint: voice/audio or video file — transcribe it with the transcribe-audio skill …]`
 *
 * @example
 * ```ts
 * inboundFileHint({ name: 'Audio Clip.m4a', mimetype: 'audio/mp4', localPath: '/tmp/a.m4a' });
 * // '[Hint: voice/audio or video file — use the transcribe-audio skill: {"audioFile":"/tmp/a.m4a"} …]'
 * ```
 */
export function inboundFileHint(file: InboundFile): string | null {
	const pathJson = JSON.stringify(file.localPath);
	if (isAudioOrVideo(file)) {
		return (
			`[Hint: voice/audio or video file — use the transcribe-audio skill: {"audioFile":${pathJson}}. ` +
			`If it answers "needsSetup": true, tell the user you are setting up transcription and run install-skill --id transcribe-audio — do not just say you cannot.]`
		);
	}
	if (isPdf(file)) {
		const text = file.extractedText?.trim() ?? '';
		if (text && !text.endsWith(EXTRACTED_TEXT_TRUNCATED_MARKER)) return null;
		const why = text ? 'only the start of its text is included above' : 'its text could not be extracted here';
		return `[Hint: PDF — ${why}; use the PDF reading skill (pdf-tools): {"action":"read","input":${pathJson}}.]`;
	}
	return null;
}
