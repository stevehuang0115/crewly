/**
 * Tests for Talk transcription (#1074): engine discovery, caps, the
 * vocabulary prompt, one-at-a-time queue, timeouts, temp-file cleanup and
 * that neither audio nor transcript reaches the logs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TALK_TRANSCRIBE_CONSTANTS as C } from '../../constants.js';
import type { CommandResult, RunCommand } from '../harness/harness.types.js';
import type { ComponentLogger } from '../core/logger.service.js';
import {
	buildVocabularyPrompt,
	decodeAudio,
	extensionForMime,
	joinSegments,
	TalkTranscribeError,
	TalkTranscribeService,
	type TalkTranscribeDeps,
} from './talk-transcribe.service.js';

const HOME = '/home/owner';
const CREWLY = '/home/owner/.crewly';
const BIN = '/opt/homebrew/bin/whisper-cli';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const MODEL = path.join(HOME, '.cache/whisper-models', C.MODEL_FILENAME);
const SECRET_TEXT = '帮我看一下 CE 的网站';
const AUDIO = Buffer.from('fake-aac-bytes-0123456789').toString('base64');

let tmpRoot: string;
let calls: Array<{ command: string; args: readonly string[] }>;
let logger: ComponentLogger & { info: jest.Mock; warn: jest.Mock; debug: jest.Mock; error: jest.Mock };

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-stt-test-'));
	calls = [];
	logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as typeof logger;
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A fake ffmpeg + whisper-cli: ffmpeg writes a WAV of `wavSeconds`, whisper
 * writes `<prefix>.json` with `segments`.
 */
function fakeRun(opts: {
	wavSeconds?: number;
	segments?: string[];
	language?: string;
	whisper?: () => Promise<CommandResult> | CommandResult;
	ffmpeg?: () => Promise<CommandResult> | CommandResult;
} = {}): RunCommand {
	return async (command, args) => {
		calls.push({ command, args });
		if (command === FFMPEG) {
			if (opts.ffmpeg) return opts.ffmpeg();
			const out = args[args.length - 1];
			const seconds = opts.wavSeconds ?? 3;
			fs.writeFileSync(out, Buffer.alloc(C.WAV_HEADER_BYTES + Math.round(seconds * C.WAV_BYTES_PER_SEC)));
			return { code: 0, stdout: '', stderr: '' };
		}
		if (opts.whisper) return opts.whisper();
		const prefix = args[args.indexOf('-of') + 1];
		fs.writeFileSync(
			`${prefix}.json`,
			JSON.stringify({
				result: { language: opts.language ?? 'zh' },
				transcription: (opts.segments ?? [SECRET_TEXT]).map((text) => ({ text })),
			}),
		);
		return { code: 0, stdout: '', stderr: '' };
	};
}

/** A service where everything is installed. */
function makeService(deps: Partial<TalkTranscribeDeps> = {}): TalkTranscribeService {
	return new TalkTranscribeService({
		run: fakeRun(),
		env: { PATH: '/usr/bin' },
		homeDir: () => HOME,
		crewlyHome: () => CREWLY,
		isExecutable: (f) => f === BIN || f === FFMPEG,
		isFile: (f) => f === MODEL,
		vocabulary: async () => ['Marketing Team', 'Ella', 'visa-site'],
		deviceName: async () => 'macbookpro',
		tmpDir: () => tmpRoot,
		cpuCount: () => 10,
		logger,
		...deps,
	});
}

/** Everything the logger was given, as one string. */
function loggedText(): string {
	return JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.debug.mock.calls, logger.error.mock.calls]);
}

describe('helpers', () => {
	it('maps MediaRecorder types to extensions', () => {
		expect(extensionForMime('audio/mp4')).toBe('m4a');
		expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm');
		expect(extensionForMime('AUDIO/AAC')).toBe('aac');
		expect(extensionForMime('video/mp4')).toBeNull();
		expect(extensionForMime('')).toBeNull();
	});

	it('decodes base64 and data URLs, refusing junk and oversize input before decoding', () => {
		expect(decodeAudio(AUDIO, 1000).toString()).toBe('fake-aac-bytes-0123456789');
		expect(decodeAudio(`data:audio/mp4;base64,${AUDIO}`, 1000).toString()).toBe('fake-aac-bytes-0123456789');
		expect(() => decodeAudio('', 1000)).toThrow(expect.objectContaining({ code: 'invalid_audio' }));
		expect(() => decodeAudio(42, 1000)).toThrow(expect.objectContaining({ code: 'invalid_audio' }));
		expect(() => decodeAudio('not base64!!', 1000)).toThrow(expect.objectContaining({ code: 'invalid_audio' }));
		expect(() => decodeAudio(Buffer.alloc(2000).toString('base64'), 1000)).toThrow(expect.objectContaining({ code: 'too_long' }));
	});

	it('builds the vocabulary prompt: zh bias first, glossary, then names, de-duplicated and bounded', () => {
		const prompt = buildVocabularyPrompt(['Marketing', 'crewly', 'Ella', '  ', 'x'.repeat(41)]);
		expect(prompt.startsWith(C.PROMPT_PREFIX)).toBe(true);
		expect(prompt).toContain('CE');
		expect(prompt).toContain('Marketing、Ella');
		expect(prompt.match(/crewly/gi)).toHaveLength(2); // "Crewly" + "Crewly Cloud", not the duplicate
		expect(prompt).not.toContain('xxxxx');
		const long = buildVocabularyPrompt(Array.from({ length: 200 }, (_, i) => `Name${i}`), 50);
		expect(long.length).toBeLessThan(C.PROMPT_PREFIX.length + 60);
	});

	it('joins segments without spaces in Chinese and with spaces between English words', () => {
		expect(joinSegments([' 帮我看一下', 'CE 的网站。 '])).toBe('帮我看一下CE 的网站。');
		expect(joinSegments(['Hello', 'world'])).toBe('Hello world');
		expect(joinSegments(['[BLANK_AUDIO]', '(music)', ' 好的 '])).toBe('好的');
	});
});

describe('resolveEngine (the transcribe-audio skill order)', () => {
	it('finds Homebrew whisper-cli, ffmpeg and the cached model', () => {
		expect(makeService().resolveEngine()).toEqual({ whisperBin: BIN, model: MODEL, ffmpeg: FFMPEG });
	});

	it('prefers FLOPOST_WHISPER_BIN / ~/.flopost and FLOPOST_WHISPER_MODEL', () => {
		const flopostBin = path.join(HOME, '.flopost/whisper/whisper-cli');
		const flopostModel = path.join(HOME, '.flopost/whisper', C.MODEL_FILENAME);
		const svc = makeService({
			isExecutable: (f) => [BIN, FFMPEG, flopostBin].includes(f),
			isFile: (f) => [MODEL, flopostModel].includes(f),
		});
		expect(svc.resolveEngine()).toMatchObject({ whisperBin: flopostBin, model: flopostModel });
		const envSvc = makeService({
			env: { PATH: '', FLOPOST_WHISPER_BIN: '/x/whisper', FLOPOST_WHISPER_MODEL: '/x/model.bin' },
			isExecutable: (f) => [BIN, FFMPEG, '/x/whisper'].includes(f),
			isFile: (f) => [MODEL, '/x/model.bin'].includes(f),
		});
		expect(envSvc.resolveEngine()).toMatchObject({ whisperBin: '/x/whisper', model: '/x/model.bin' });
	});

	it('finds whisper-cli in $CREWLY_HOME/bin (the Linux install)', () => {
		const crewlyBin = path.join(CREWLY, 'bin', 'whisper-cli');
		const svc = makeService({ isExecutable: (f) => f === crewlyBin || f === FFMPEG });
		expect(svc.resolveEngine().whisperBin).toBe(crewlyBin);
	});

	it('reports what is missing and only advertises talk_whisper when ready', async () => {
		const svc = makeService({ isExecutable: () => false, isFile: () => false });
		const status = await svc.getStatus();
		expect(status).toMatchObject({ whisperReady: false, missing: ['ffmpeg', 'whisper-cli', 'whisper-model'], deviceName: 'macbookpro' });
		expect(svc.capabilities()).toEqual([]);
		expect(makeService().capabilities()).toEqual([C.CAPABILITY]);
		expect((await makeService().getStatus()).whisperReady).toBe(true);
	});
});

describe('transcribe', () => {
	it('converts with ffmpeg, runs whisper with auto language + vocabulary prompt, and returns the text', async () => {
		const svc = makeService();
		const result = await svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' });
		expect(result).toMatchObject({ text: SECRET_TEXT, language: 'zh', durationSec: 3, engine: 'whisper.cpp', deviceName: 'macbookpro' });

		const ff = calls.find((c) => c.command === FFMPEG) ?? { args: [] as readonly string[] };
		expect(ff.args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
		expect(ff.args[ff.args.indexOf('-i') + 1]).toMatch(/clip\.m4a$/);

		const w = calls.find((c) => c.command === BIN) ?? { args: [] as readonly string[] };
		expect(w.args[w.args.indexOf('-m') + 1]).toBe(MODEL);
		expect(w.args[w.args.indexOf('-l') + 1]).toBe('auto');
		expect(w.args[w.args.indexOf('-t') + 1]).toBe('8');
		const prompt = w.args[w.args.indexOf('--prompt') + 1];
		expect(prompt.startsWith('以下是普通话的句子。')).toBe(true);
		expect(prompt).toContain('CE');
		expect(prompt).toContain('Marketing Team');
		expect(prompt).toContain('Ella');
		expect(prompt).toContain('visa-site');
	});

	it('passes a language hint through and refuses unknown ones', async () => {
		await makeService().transcribe({ audio: AUDIO, mimeType: 'audio/webm;codecs=opus', language: 'en' });
		const w = calls.find((c) => c.command === BIN) ?? { args: [] as readonly string[] };
		expect(w.args[w.args.indexOf('-l') + 1]).toBe('en');
		await expect(makeService().transcribe({ audio: AUDIO, mimeType: 'audio/mp4', language: 'fr' })).rejects.toMatchObject({ code: 'invalid_audio' });
	});

	it('removes its temp files on success and on failure', async () => {
		await makeService().transcribe({ audio: AUDIO, mimeType: 'audio/mp4' });
		expect(fs.readdirSync(tmpRoot)).toEqual([]);
		const failing = makeService({ run: fakeRun({ whisper: () => ({ code: 1, stdout: '', stderr: 'boom' }) }) });
		await expect(failing.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })).rejects.toMatchObject({ code: 'failed' });
		expect(fs.readdirSync(tmpRoot)).toEqual([]);
	});

	it('never logs the audio or the transcript', async () => {
		await makeService().transcribe({ audio: AUDIO, mimeType: 'audio/mp4' });
		await makeService({ run: fakeRun({ whisper: () => ({ code: 1, stdout: SECRET_TEXT, stderr: SECRET_TEXT }) }) })
			.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })
			.catch(() => undefined);
		const logged = loggedText();
		expect(logged).not.toContain('帮我看一下');
		expect(logged).not.toContain(AUDIO);
		expect(logger.info).toHaveBeenCalledWith('Talk clip transcribed', expect.objectContaining({ chars: SECRET_TEXT.length }));
	});

	it('whisper_unavailable when the engine is not set up (before any work)', async () => {
		const svc = makeService({ isFile: () => false });
		await expect(svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })).rejects.toMatchObject({ code: 'whisper_unavailable' });
		expect(calls).toEqual([]);
	});

	it('too_long by size and by decoded duration', async () => {
		const small = makeService({ limits: { maxAudioBytes: 10 } });
		await expect(small.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })).rejects.toMatchObject({ code: 'too_long' });
		const long = makeService({ run: fakeRun({ wavSeconds: C.MAX_DURATION_SEC + 0.5 }) });
		const err = await long.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' }).catch((e: TalkTranscribeError) => e);
		expect(err).toMatchObject({ code: 'too_long' });
		expect((err as TalkTranscribeError).httpStatus).toBe(413);
		expect(calls.some((c) => c.command === BIN)).toBe(false);
	});

	it('invalid_audio for an unknown type or audio ffmpeg cannot decode', async () => {
		await expect(makeService().transcribe({ audio: AUDIO, mimeType: 'text/plain' })).rejects.toMatchObject({ code: 'invalid_audio' });
		const bad = makeService({ run: fakeRun({ ffmpeg: () => ({ code: 1, stdout: '', stderr: 'Invalid data' }) }) });
		await expect(bad.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })).rejects.toMatchObject({ code: 'invalid_audio' });
	});

	it('timeout when whisper runs past the deadline', async () => {
		const svc = makeService({ run: fakeRun({ whisper: () => ({ code: null, stdout: '', stderr: '', error: 'timed out after 100 ms' }) }) });
		const err = await svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' }).catch((e: TalkTranscribeError) => e);
		expect(err).toMatchObject({ code: 'timeout' });
		expect((err as TalkTranscribeError).httpStatus).toBe(504);
		expect(fs.readdirSync(tmpRoot)).toEqual([]);
	});

	it('returns empty text when whisper only echoes its prompt (silence)', async () => {
		const svc = makeService({ run: fakeRun({ segments: [C.PROMPT_PREFIX] }) });
		expect((await svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })).text).toBe('');
	});
});

describe('one transcription at a time', () => {
	it('queues the next request until the running one finishes', async () => {
		let releaseFirst: () => void = () => undefined;
		let whisperRuns = 0;
		const base = fakeRun();
		const run: RunCommand = async (command, args, options) => {
			if (command === BIN && whisperRuns++ === 0) {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return base(command, args, options);
		};
		const svc = makeService({ run });
		const first = svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' });
		await new Promise((r) => setTimeout(r, 20));
		const second = svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' });
		await new Promise((r) => setTimeout(r, 20));
		expect(await svc.getStatus()).toMatchObject({ busy: true, queued: 1 });
		expect(calls.filter((c) => c.command === FFMPEG)).toHaveLength(1);
		releaseFirst();
		await expect(first).resolves.toMatchObject({ text: SECRET_TEXT });
		await expect(second).resolves.toMatchObject({ text: SECRET_TEXT });
		expect(await svc.getStatus()).toMatchObject({ busy: false, queued: 0 });
	});

	it('busy when the queue is full, timeout when the wait outlasts the deadline', async () => {
		let releaseFirst: () => void = () => undefined;
		const base = fakeRun();
		const run: RunCommand = async (command, args, options) => {
			if (command === BIN) {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return base(command, args, options);
		};
		const svc = makeService({ run, limits: { maxQueue: 1, requestTimeoutMs: 80 } });
		const first = svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' }).catch((e) => e);
		await new Promise((r) => setTimeout(r, 10));
		const waiting = svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' });
		await expect(svc.transcribe({ audio: AUDIO, mimeType: 'audio/mp4' })).rejects.toMatchObject({ code: 'busy' });
		await expect(waiting).rejects.toMatchObject({ code: 'timeout' });
		releaseFirst();
		await first;
		expect(await svc.getStatus()).toMatchObject({ busy: false, queued: 0 });
	});
});

describe('setup', () => {
	it('reports ready without starting anything when the engine is there', async () => {
		const startSetup = jest.fn();
		expect(await makeService({ startSetup }).startSetup()).toMatchObject({ state: 'succeeded' });
		expect(startSetup).not.toHaveBeenCalled();
	});

	it('starts the transcribe-audio setup and reports its job state in status', async () => {
		const startSetup = jest.fn(async () => ({ state: 'running' as const, jobId: 'job-1' }));
		const setupJob = jest.fn(async () => ({ state: 'succeeded' as const, jobId: 'job-1', message: 'done' }));
		const svc = makeService({ isFile: () => false, startSetup, setupJob });
		expect(await svc.startSetup()).toEqual({ state: 'running', jobId: 'job-1' });
		expect((await svc.getStatus()).setup).toEqual({ state: 'succeeded', jobId: 'job-1', message: 'done' });
		expect(setupJob).toHaveBeenCalledWith('job-1');
	});

	it('failed when setup cannot start', async () => {
		const svc = makeService({ isFile: () => false, startSetup: async () => { throw new Error('not_found'); } });
		await expect(svc.startSetup()).rejects.toMatchObject({ code: 'failed' });
		expect((await svc.getStatus()).setup).toMatchObject({ state: 'failed' });
		await expect(makeService({ isFile: () => false }).startSetup()).rejects.toMatchObject({ code: 'failed' });
	});
});
