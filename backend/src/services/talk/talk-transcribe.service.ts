/**
 * Talk transcription — speech-to-text for the portal Talk page on the
 * owner's own machine (specs/2026-10-04-talk-whisper-transcribe.md, #1074).
 *
 * The phone records a short clip and sends it over the relay to the machine
 * of the agent being talked to; this service turns it into text with
 * whisper.cpp and hands the text back. It never sends anything to an agent:
 * the owner reads, edits and confirms the text on the phone first.
 *
 * Engine: the `transcribe-audio` skill's — same `whisper-cli` lookup order,
 * same large-v3-turbo model file, same ffmpeg normalisation to 16 kHz mono
 * WAV. Its setup block is what installs the pieces ({@link startSetup}).
 *
 * Properties:
 * - **One at a time.** whisper uses most of the CPU; requests queue behind
 *   the running one (at most {@link TALK_TRANSCRIBE_CONSTANTS.MAX_QUEUE}
 *   waiting) and share one deadline that includes the wait.
 * - **Nothing kept.** Audio is written to a private temp dir that is removed
 *   in `finally`; neither audio nor transcript is ever logged.
 * - **Clear failures.** Every refusal carries a code the phone acts on by
 *   falling back to on-device recognition: `whisper_unavailable`,
 *   `too_long`, `timeout`, `failed` (and `busy`, `invalid_audio`).
 *
 * @module services/talk/talk-transcribe.service
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SKILL_SETUP_CONSTANTS, TALK_TRANSCRIBE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { resolveExecutable, runCommand } from '../harness/harness-exec.utils.js';
import type { RunCommand } from '../harness/harness.types.js';

const C = TALK_TRANSCRIBE_CONSTANTS;

/** Error code returned to the phone. */
export type TalkTranscribeCode = (typeof C.CODES)[keyof typeof C.CODES];

/** HTTP status for each refusal. */
export const TALK_TRANSCRIBE_HTTP_STATUS: Readonly<Record<TalkTranscribeCode, number>> = {
	[C.CODES.WHISPER_UNAVAILABLE]: 503,
	[C.CODES.TOO_LONG]: 413,
	[C.CODES.TIMEOUT]: 504,
	[C.CODES.FAILED]: 500,
	[C.CODES.BUSY]: 429,
	[C.CODES.INVALID_AUDIO]: 400,
	[C.CODES.OWNER_ONLY]: 403,
};

/** A refusal with a machine-readable code. Its message never contains audio or transcript. */
export class TalkTranscribeError extends Error {
	/**
	 * @param code - What went wrong (the phone falls back on any of them)
	 * @param message - Short English explanation
	 */
	constructor(
		public readonly code: TalkTranscribeCode,
		message: string,
	) {
		super(message);
		this.name = 'TalkTranscribeError';
	}

	/** HTTP status for this refusal. */
	get httpStatus(): number {
		return TALK_TRANSCRIBE_HTTP_STATUS[this.code];
	}
}

/** Where the engine's pieces are (null = missing). */
export interface WhisperEngine {
	whisperBin: string | null;
	model: string | null;
	ffmpeg: string | null;
}

/** The setup job started from the phone, as far as this service knows. */
export interface TalkSetupState {
	state: 'running' | 'succeeded' | 'failed';
	jobId?: string;
	message?: string;
}

/** `GET /api/talk/transcribe/status` data. */
export interface TalkTranscribeStatus {
	/** whisper-cli, the model and ffmpeg are all present */
	whisperReady: boolean;
	/** Missing pieces, by the skill's setup step ids (`ffmpeg`, `whisper-cli`, `whisper-model`) */
	missing: string[];
	/** This machine's name (for "Whisper · <machine>") */
	deviceName: string;
	/** A transcription is running */
	busy: boolean;
	/** Requests waiting behind it */
	queued: number;
	maxDurationSec: number;
	maxAudioBytes: number;
	/** Setup started from the phone, if any */
	setup?: TalkSetupState;
}

/** Input to {@link TalkTranscribeService.transcribe}. */
export interface TranscribeInput {
	/** Base64 audio (a `data:` URL prefix is tolerated) */
	audio: unknown;
	/** Container type from MediaRecorder, e.g. `audio/mp4` or `audio/webm;codecs=opus` */
	mimeType: unknown;
	/** `auto` (default), `zh` or `en` */
	language?: unknown;
}

/** A finished transcription. */
export interface TranscribeResult {
	text: string;
	/** Language whisper detected (or was told) */
	language: string;
	durationSec: number;
	engine: 'whisper.cpp';
	deviceName: string;
	/** Time spent, including any wait in the queue (ms) */
	elapsedMs: number;
}

/** Injectable dependencies (all optional). */
export interface TalkTranscribeDeps {
	run?: RunCommand;
	env?: NodeJS.ProcessEnv;
	homeDir?: () => string;
	crewlyHome?: () => string;
	isExecutable?: (file: string) => boolean;
	isFile?: (file: string) => boolean;
	/** Team / agent / project names for the vocabulary prompt */
	vocabulary?: () => Promise<string[]>;
	deviceName?: () => Promise<string>;
	/** Start the transcribe-audio skill setup in the background */
	startSetup?: () => Promise<TalkSetupState>;
	/** Current state of a setup job */
	setupJob?: (jobId: string) => Promise<TalkSetupState | null>;
	tmpDir?: () => string;
	cpuCount?: () => number;
	now?: () => number;
	logger?: ComponentLogger;
	/** Overrides of the limits (tests) */
	limits?: Partial<{ maxAudioBytes: number; maxDurationSec: number; requestTimeoutMs: number; maxQueue: number }>;
}

/**
 * Whether a file exists and is executable.
 *
 * @param file - Absolute path
 * @returns True when executable
 */
function defaultIsExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether a regular file exists.
 *
 * @param file - Absolute path
 * @returns True when it is a file
 */
function defaultIsFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Temp-file extension for a MediaRecorder type (`audio/webm;codecs=opus` → `webm`).
 *
 * @param mimeType - Container type
 * @returns Extension, or null when the type is not audio we take
 */
export function extensionForMime(mimeType: string): string | null {
	const base = mimeType.split(';')[0].trim().toLowerCase();
	return C.MIME_EXTENSIONS[base] ?? null;
}

/**
 * Decode the base64 body, refusing anything malformed or over the size cap
 * before decoding it.
 *
 * @param audio - Base64 string, optionally a `data:` URL
 * @param maxBytes - Size cap of the decoded audio
 * @returns The audio bytes
 * @throws TalkTranscribeError `invalid_audio` or `too_long`
 */
export function decodeAudio(audio: unknown, maxBytes: number): Buffer {
	if (typeof audio !== 'string' || audio.length === 0) {
		throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, 'audio (base64) is required');
	}
	const comma = audio.startsWith('data:') ? audio.indexOf(',') : -1;
	const b64 = (comma >= 0 ? audio.slice(comma + 1) : audio).replace(/\s+/g, '');
	if (b64.length > Math.ceil(maxBytes / 3) * 4) {
		throw new TalkTranscribeError(C.CODES.TOO_LONG, `The clip is larger than ${Math.round(maxBytes / 1024)} KB`);
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
		throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, 'audio is not valid base64');
	}
	const bytes = Buffer.from(b64, 'base64');
	if (bytes.length === 0) throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, 'audio is empty');
	if (bytes.length > maxBytes) {
		throw new TalkTranscribeError(C.CODES.TOO_LONG, `The clip is larger than ${Math.round(maxBytes / 1024)} KB`);
	}
	return bytes;
}

/**
 * The initial prompt: the Simplified-Chinese bias sentence, then the owner
 * glossary and this machine's team / agent / project names, so names like
 * "CE" are not heard as "侧". Bounded so whisper keeps all of it.
 *
 * @param names - Vocabulary from this machine
 * @param maxChars - Bound on the vocabulary part
 * @returns Prompt text
 *
 * @example
 * ```ts
 * buildVocabularyPrompt(['Marketing', 'Ella']);
 * // '以下是普通话的句子。Crewly、CE、Crewly Cloud、Slack、Marketing、Ella。'
 * ```
 */
export function buildVocabularyPrompt(names: readonly string[], maxChars: number = C.MAX_VOCAB_CHARS): string {
	const seen = new Set<string>();
	const words: string[] = [];
	let used = 0;
	for (const raw of [...C.GLOSSARY, ...names]) {
		const word = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
		if (!word || word.length > 40) continue;
		const key = word.toLowerCase();
		if (seen.has(key)) continue;
		if (used + word.length + 1 > maxChars) break;
		seen.add(key);
		words.push(word);
		used += word.length + 1;
	}
	return words.length > 0 ? `${C.PROMPT_PREFIX}${words.join('、')}。` : C.PROMPT_PREFIX;
}

/**
 * Join whisper segments: a space only between two Latin-script edges, so
 * Chinese stays unspaced and English words stay apart.
 *
 * @param segments - Segment texts
 * @returns The transcript
 */
export function joinSegments(segments: readonly string[]): string {
	let out = '';
	for (const raw of segments) {
		const seg = raw.trim();
		if (!seg || /^\[.*\]$/.test(seg) || /^\(.*\)$/.test(seg)) continue; // [BLANK_AUDIO], (music)
		if (out && /[A-Za-z0-9.,!?;:]$/.test(out) && /^[A-Za-z0-9]/.test(seg)) out += ' ';
		out += seg;
	}
	return out.trim();
}

/** whisper.cpp `-oj` output (only what we read). */
interface WhisperJson {
	result?: { language?: string };
	transcription?: Array<{ text?: string }>;
}

/** Talk speech-to-text with whisper.cpp. */
export class TalkTranscribeService {
	private readonly run: RunCommand;
	private readonly env: NodeJS.ProcessEnv;
	private readonly homeDir: () => string;
	private readonly crewlyHome: () => string;
	private readonly isExecutable: (file: string) => boolean;
	private readonly isFile: (file: string) => boolean;
	private readonly vocabulary: () => Promise<string[]>;
	private readonly deviceNameFn: () => Promise<string>;
	private readonly startSetupFn: (() => Promise<TalkSetupState>) | null;
	private readonly setupJobFn: ((jobId: string) => Promise<TalkSetupState | null>) | null;
	private readonly tmpDir: () => string;
	private readonly cpuCount: () => number;
	private readonly now: () => number;
	private readonly logger: ComponentLogger;
	private readonly maxAudioBytes: number;
	private readonly maxDurationSec: number;
	private readonly requestTimeoutMs: number;
	private readonly maxQueue: number;

	private running = false;
	private readonly waiters: Array<() => void> = [];
	private lastSetup: TalkSetupState | null = null;

	/**
	 * @param deps - Injectable dependencies
	 */
	constructor(deps: TalkTranscribeDeps = {}) {
		this.run = deps.run ?? runCommand;
		this.env = deps.env ?? process.env;
		this.homeDir = deps.homeDir ?? os.homedir;
		this.crewlyHome = deps.crewlyHome ?? getCrewlyHomePath;
		this.isExecutable = deps.isExecutable ?? defaultIsExecutable;
		this.isFile = deps.isFile ?? defaultIsFile;
		this.vocabulary = deps.vocabulary ?? (async () => []);
		this.deviceNameFn = deps.deviceName ?? (async () => os.hostname());
		this.startSetupFn = deps.startSetup ?? null;
		this.setupJobFn = deps.setupJob ?? null;
		this.tmpDir = deps.tmpDir ?? os.tmpdir;
		this.cpuCount = deps.cpuCount ?? (() => os.cpus().length);
		this.now = deps.now ?? Date.now;
		this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('TalkTranscribe');
		this.maxAudioBytes = deps.limits?.maxAudioBytes ?? C.MAX_AUDIO_BYTES;
		this.maxDurationSec = deps.limits?.maxDurationSec ?? C.MAX_DURATION_SEC;
		this.requestTimeoutMs = deps.limits?.requestTimeoutMs ?? C.REQUEST_TIMEOUT_MS;
		this.maxQueue = deps.limits?.maxQueue ?? C.MAX_QUEUE;
	}

	// -------------------------------------------------------------------------
	// Engine discovery (the transcribe-audio skill's order)
	// -------------------------------------------------------------------------

	/**
	 * PATH searched for commands: `$CREWLY_HOME/bin`, the process PATH, then
	 * the usual system and Homebrew dirs (a backend started by launchd often
	 * lacks /opt/homebrew/bin) — the skill setup runner's search path.
	 *
	 * @returns PATH string
	 */
	private searchPath(): string {
		const entries = [
			path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.BIN_DIR),
			...(this.env.PATH ?? '').split(path.delimiter),
			...SKILL_SETUP_CONSTANTS.EXTRA_COMMAND_DIRS,
		].filter((e) => e.length > 0);
		return [...new Set(entries)].join(path.delimiter);
	}

	/**
	 * Find whisper-cli, the model and ffmpeg. Checked on every call (cheap
	 * file checks), so a finished setup is seen at once.
	 *
	 * Order, as in `transcribe-audio/execute.sh`: `FLOPOST_WHISPER_BIN`,
	 * `~/.flopost/whisper/whisper-cli`, `$CREWLY_HOME/bin`, PATH, Homebrew;
	 * model: `FLOPOST_WHISPER_MODEL`, `~/.flopost/whisper/`, `~/.cache/whisper-models/`.
	 *
	 * @returns Paths (null = missing)
	 */
	resolveEngine(): WhisperEngine {
		const home = this.homeDir();
		let whisperBin: string | null = null;
		const envBin = this.env.FLOPOST_WHISPER_BIN;
		if (envBin && this.isExecutable(envBin)) whisperBin = envBin;
		for (const rel of C.HOME_BIN_CANDIDATES) {
			if (whisperBin) break;
			const p = path.join(home, rel);
			if (this.isExecutable(p)) whisperBin = p;
		}
		const searchPath = this.searchPath();
		whisperBin ??= resolveExecutable(C.WHISPER_BINARY, searchPath, this.isExecutable);

		let model: string | null = null;
		const envModel = this.env.FLOPOST_WHISPER_MODEL;
		if (envModel && this.isFile(envModel)) model = envModel;
		for (const dir of C.MODEL_DIRS) {
			if (model) break;
			const p = path.join(home, dir, C.MODEL_FILENAME);
			if (this.isFile(p)) model = p;
		}

		const ffmpeg = resolveExecutable(C.FFMPEG_BINARY, searchPath, this.isExecutable);
		return { whisperBin, model, ffmpeg };
	}

	/**
	 * Missing pieces, named by the skill's setup step ids.
	 *
	 * @param engine - Resolved engine
	 * @returns e.g. `['whisper-model']`
	 */
	private missingParts(engine: WhisperEngine): string[] {
		const missing: string[] = [];
		if (!engine.ffmpeg) missing.push('ffmpeg');
		if (!engine.whisperBin) missing.push('whisper-cli');
		if (!engine.model) missing.push('whisper-model');
		return missing;
	}

	/**
	 * Whether a transcription can run here now.
	 *
	 * @returns True when whisper-cli, the model and ffmpeg are present
	 */
	isReady(): boolean {
		return this.missingParts(this.resolveEngine()).length === 0;
	}

	/**
	 * Capabilities for the Cloud heartbeat: `talk_whisper` while ready.
	 *
	 * @returns Capability list
	 */
	capabilities(): string[] {
		return this.isReady() ? [C.CAPABILITY] : [];
	}

	/**
	 * This machine's name, never failing.
	 *
	 * @returns Device name
	 */
	private async deviceName(): Promise<string> {
		try {
			return (await this.deviceNameFn()) || os.hostname();
		} catch {
			return os.hostname();
		}
	}

	/**
	 * Status for the phone: ready or not, what is missing, queue, setup.
	 *
	 * @returns Status
	 */
	async getStatus(): Promise<TalkTranscribeStatus> {
		const missing = this.missingParts(this.resolveEngine());
		const setup = await this.currentSetup();
		return {
			whisperReady: missing.length === 0,
			missing,
			deviceName: await this.deviceName(),
			busy: this.running,
			queued: this.waiters.length,
			maxDurationSec: this.maxDurationSec,
			maxAudioBytes: this.maxAudioBytes,
			...(setup ? { setup } : {}),
		};
	}

	/**
	 * The last setup job, refreshed from the job service.
	 *
	 * @returns State, or null when none was started here
	 */
	private async currentSetup(): Promise<TalkSetupState | null> {
		if (!this.lastSetup) return null;
		if (this.lastSetup.jobId && this.setupJobFn) {
			const fresh = await this.setupJobFn(this.lastSetup.jobId).catch(() => null);
			if (fresh) this.lastSetup = fresh;
		}
		return this.lastSetup;
	}

	/**
	 * Install ffmpeg, whisper-cli and the model with the transcribe-audio
	 * skill's setup block, in the background (unattended; the skill is
	 * official). Returns at once.
	 *
	 * @returns The setup state (`succeeded` when everything was already there)
	 * @throws TalkTranscribeError `failed` when setup cannot be started
	 */
	async startSetup(): Promise<TalkSetupState> {
		if (this.isReady()) {
			this.lastSetup = { state: 'succeeded', message: 'Whisper is ready' };
			return this.lastSetup;
		}
		if (!this.startSetupFn) throw new TalkTranscribeError(C.CODES.FAILED, 'Setup is not available on this machine');
		try {
			this.lastSetup = await this.startSetupFn();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastSetup = { state: 'failed', message };
			throw new TalkTranscribeError(C.CODES.FAILED, message);
		}
		this.logger.info('Whisper setup for Talk started', { state: this.lastSetup.state, jobId: this.lastSetup.jobId });
		return this.lastSetup;
	}

	// -------------------------------------------------------------------------
	// Transcription
	// -------------------------------------------------------------------------

	/**
	 * Take the one-at-a-time slot, waiting until `deadline` at most.
	 *
	 * @param deadline - Absolute ms
	 * @throws TalkTranscribeError `busy` (queue full) or `timeout`
	 */
	private acquire(deadline: number): Promise<void> {
		if (!this.running) {
			this.running = true;
			return Promise.resolve();
		}
		if (this.waiters.length >= this.maxQueue) {
			return Promise.reject(new TalkTranscribeError(C.CODES.BUSY, 'Another transcription is running; try again in a moment'));
		}
		return new Promise<void>((resolve, reject) => {
			const grant = (): void => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(grant);
				if (i >= 0) this.waiters.splice(i, 1);
				reject(new TalkTranscribeError(C.CODES.TIMEOUT, 'Timed out waiting for the previous transcription'));
			}, Math.max(0, deadline - this.now()));
			this.waiters.push(grant);
		});
	}

	/** Hand the slot to the next waiter, or free it. */
	private release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.running = false;
	}

	/**
	 * Transcribe one clip.
	 *
	 * Validation (type, size, engine present) happens before queueing; the
	 * deadline covers the wait, ffmpeg and whisper. Temp files are removed in
	 * `finally`. Logs carry only sizes, durations and codes.
	 *
	 * @param input - Base64 audio, container type, language hint
	 * @returns The transcript
	 * @throws TalkTranscribeError with a code the phone falls back on
	 *
	 * @example
	 * ```ts
	 * const r = await svc.transcribe({ audio: b64, mimeType: 'audio/mp4' });
	 * // { text: '帮我看一下 CE 的网站', language: 'zh', durationSec: 3.2, ... }
	 * ```
	 */
	async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
		const started = this.now();
		const deadline = started + this.requestTimeoutMs;
		const mimeType = typeof input.mimeType === 'string' ? input.mimeType : '';
		const ext = extensionForMime(mimeType);
		if (!ext) throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, `Unsupported audio type: ${mimeType.slice(0, 60) || '(none)'}`);
		const language = input.language === undefined || input.language === null || input.language === '' ? 'auto' : input.language;
		if (typeof language !== 'string' || !(C.LANGUAGES as readonly string[]).includes(language)) {
			throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, `language must be one of ${C.LANGUAGES.join(', ')}`);
		}
		const bytes = decodeAudio(input.audio, this.maxAudioBytes);
		const engine = this.resolveEngine();
		const missing = this.missingParts(engine);
		if (missing.length > 0) {
			throw new TalkTranscribeError(C.CODES.WHISPER_UNAVAILABLE, `Whisper is not set up on this machine (missing: ${missing.join(', ')})`);
		}

		await this.acquire(deadline);
		let workDir: string | null = null;
		try {
			workDir = fs.mkdtempSync(path.join(this.tmpDir(), C.TEMP_PREFIX));
			const paths = { whisperBin: engine.whisperBin as string, model: engine.model as string, ffmpeg: engine.ffmpeg as string };
			const result = await this.runEngine(paths, workDir, bytes, ext, language, deadline);
			const elapsedMs = this.now() - started;
			this.logger.info('Talk clip transcribed', {
				bytes: bytes.length,
				durationSec: result.durationSec,
				language: result.language,
				chars: result.text.length,
				elapsedMs,
			});
			return { ...result, engine: 'whisper.cpp', deviceName: await this.deviceName(), elapsedMs };
		} catch (error) {
			const code = error instanceof TalkTranscribeError ? error.code : C.CODES.FAILED;
			this.logger.warn('Talk clip not transcribed', { code, bytes: bytes.length, elapsedMs: this.now() - started });
			if (error instanceof TalkTranscribeError) throw error;
			throw new TalkTranscribeError(C.CODES.FAILED, 'Transcription failed');
		} finally {
			if (workDir) {
				try {
					fs.rmSync(workDir, { recursive: true, force: true });
				} catch {
					/* best effort; the OS temp dir is cleaned anyway */
				}
			}
			this.release();
		}
	}

	/**
	 * ffmpeg → WAV, duration check, whisper-cli → JSON → text.
	 *
	 * @param engine - Resolved paths (all present)
	 * @param workDir - Private temp dir
	 * @param bytes - Encoded audio
	 * @param ext - Input extension
	 * @param language - `auto` / `zh` / `en`
	 * @param deadline - Absolute ms
	 * @returns Text, language, duration
	 */
	private async runEngine(
		engine: { whisperBin: string; model: string; ffmpeg: string },
		workDir: string,
		bytes: Buffer,
		ext: string,
		language: string,
		deadline: number,
	): Promise<{ text: string; language: string; durationSec: number }> {
		const inFile = path.join(workDir, `clip.${ext}`);
		const wav = path.join(workDir, 'clip.wav');
		fs.writeFileSync(inFile, bytes, { mode: 0o600 });
		const env = { ...this.env, PATH: this.searchPath() };

		const remaining = (): number => {
			const ms = deadline - this.now();
			if (ms <= 0) throw new TalkTranscribeError(C.CODES.TIMEOUT, 'Transcription timed out');
			return ms;
		};

		// One second past the cap is decoded so an over-long clip is detected, not silently cut.
		const conv = await this.run(
			engine.ffmpeg,
			['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inFile, '-t', String(this.maxDurationSec + 1), '-vn', '-ac', '1', '-ar', String(C.SAMPLE_RATE), '-c:a', 'pcm_s16le', wav],
			{ env, timeoutMs: remaining() },
		);
		if (conv.code !== 0) {
			if (conv.code === null && /timed out/.test(conv.error ?? '')) throw new TalkTranscribeError(C.CODES.TIMEOUT, 'Transcription timed out');
			throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, 'Could not decode the audio');
		}
		let wavBytes = 0;
		try {
			wavBytes = fs.statSync(wav).size;
		} catch {
			throw new TalkTranscribeError(C.CODES.INVALID_AUDIO, 'Could not decode the audio');
		}
		const durationSec = Math.max(0, (wavBytes - C.WAV_HEADER_BYTES) / C.WAV_BYTES_PER_SEC);
		if (durationSec > this.maxDurationSec) {
			throw new TalkTranscribeError(C.CODES.TOO_LONG, `The clip is longer than ${this.maxDurationSec} s`);
		}
		const rounded = Math.round(durationSec * 100) / 100;

		const prompt = buildVocabularyPrompt(await this.vocabulary().catch(() => []));
		const prefix = path.join(workDir, 'out');
		const threads = Math.max(C.MIN_THREADS, this.cpuCount() - C.THREADS_RESERVED);
		const res = await this.run(
			engine.whisperBin,
			['-m', engine.model, '-f', wav, '-l', language, '--prompt', prompt, '-oj', '-of', prefix, '-t', String(threads), '-np'],
			{ env, timeoutMs: remaining() },
		);
		if (res.code !== 0) {
			if (res.code === null && /timed out/.test(res.error ?? '')) throw new TalkTranscribeError(C.CODES.TIMEOUT, 'Transcription timed out');
			throw new TalkTranscribeError(C.CODES.FAILED, `whisper-cli exited with ${res.code ?? 'an error'}`);
		}
		let parsed: WhisperJson;
		try {
			parsed = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8')) as WhisperJson;
		} catch {
			throw new TalkTranscribeError(C.CODES.FAILED, 'whisper-cli produced no readable output');
		}
		let text = joinSegments((parsed.transcription ?? []).map((s) => (typeof s.text === 'string' ? s.text : '')));
		// On silence whisper can echo its prompt back; that is not what was said.
		if (text === C.PROMPT_PREFIX || text === prompt) text = '';
		const detected = parsed.result?.language || (language === 'auto' ? 'auto' : language);
		return { text, language: detected, durationSec: rounded };
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: TalkTranscribeService | null = null;

/**
 * The process-wide service, created with the default dependencies on first use.
 *
 * @returns The service
 */
export function getTalkTranscribeService(): TalkTranscribeService {
	instance ??= new TalkTranscribeService(defaultDeps());
	return instance;
}

/**
 * Replace the process-wide service (tests; null resets).
 *
 * @param service - Service or null
 */
export function setTalkTranscribeService(service: TalkTranscribeService | null): void {
	instance = service;
}

/**
 * Capabilities for the Cloud heartbeat (`talk_whisper` while Whisper is ready).
 *
 * @returns Capability list
 */
export function talkTranscribeCapabilities(): string[] {
	try {
		return getTalkTranscribeService().capabilities();
	} catch {
		return [];
	}
}

/**
 * Production wiring: vocabulary from storage, the device name, and the skill
 * install job service for setup. Imports are lazy so the module stays light.
 *
 * @returns Dependencies
 */
function defaultDeps(): TalkTranscribeDeps {
	return {
		vocabulary: async () => {
			const { StorageService } = await import('../core/storage.service.js');
			const storage = StorageService.getInstance();
			const [teams, projects] = await Promise.all([storage.getTeams().catch(() => []), storage.getProjects().catch(() => [])]);
			const names: string[] = [];
			for (const team of teams) {
				names.push(team.name);
				for (const member of team.members ?? []) names.push(member.name);
			}
			for (const project of projects) names.push(project.name);
			return names.filter((n): n is string => typeof n === 'string');
		},
		deviceName: async () => {
			const { DeviceIdentityService } = await import('../cloud/device-identity.service.js');
			return (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceName;
		},
		startSetup: async () => {
			const { getSkillInstallJobService } = await import('../skill-setup/skill-install-job.service.js');
			const started = await getSkillInstallJobService().startInstall({ skillId: C.SKILL_ID, ownerDashboard: true });
			if (started.kind === 'already-ready') return { state: 'succeeded', message: 'Whisper is ready' };
			return { state: started.job.state, jobId: started.job.jobId, ...(started.job.message ? { message: started.job.message } : {}) };
		},
		setupJob: async (jobId: string) => {
			const { getSkillInstallJobService } = await import('../skill-setup/skill-install-job.service.js');
			try {
				const job = getSkillInstallJobService().getJob(jobId);
				return { state: job.state, jobId: job.jobId, ...(job.message ? { message: job.message } : {}) };
			} catch {
				return null;
			}
		},
	};
}
