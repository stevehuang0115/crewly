import { readFileSync } from 'fs';
import path from 'path';
import { recipeFor, recipeLookupOrder, validateSetupManifest, type CommandStep } from './skill-setup-manifest.js';

/** Repo root (this file is four directories below it). */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const ffmpeg = {
	id: 'ffmpeg',
	type: 'command',
	check: { commands: ['ffmpeg'] },
	install: { darwin: { brew: ['ffmpeg'] }, debian: { apt: ['ffmpeg'] } },
};
const model = {
	id: 'model',
	type: 'file',
	url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
	sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
	sizeBytes: 574041195,
	dest: '~/.cache/whisper-models/ggml-large-v3-turbo-q5_0.bin',
	alternatives: ['~/.flopost/whisper/ggml-large-v3-turbo-q5_0.bin'],
};
const python = { id: 'py', type: 'python', packages: ['pypdf>=4', 'weasyprint'], imports: ['pypdf', 'weasyprint'] };

describe('validateSetupManifest', () => {
	it('accepts a manifest with all three step types', () => {
		const result = validateSetupManifest({ estimatedMinutes: 5, steps: [ffmpeg, model, python] });
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.manifest?.steps).toHaveLength(3);
	});

	it('rejects non-objects, empty steps and unknown fields', () => {
		expect(validateSetupManifest(null).valid).toBe(false);
		expect(validateSetupManifest({ steps: [] }).errors).toContain('setup.steps must be a non-empty array');
		expect(validateSetupManifest({ steps: [ffmpeg], extra: 1 }).errors).toContain('setup.extra is not a known field');
	});

	it('rejects duplicate step ids and a bad estimate', () => {
		const result = validateSetupManifest({ estimatedMinutes: -1, steps: [ffmpeg, { ...ffmpeg }] });
		expect(result.valid).toBe(false);
		expect(result.errors.join('\n')).toMatch(/estimatedMinutes/);
		expect(result.errors.join('\n')).toMatch(/duplicated: ffmpeg/);
	});

	it('rejects shell smuggled into package names', () => {
		const bad = { ...ffmpeg, install: { debian: { apt: ['ffmpeg; rm -rf /'] } } };
		const result = validateSetupManifest({ steps: [bad] });
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatch(/install\.debian\.apt: invalid entry/);
	});

	it('rejects unknown OS keys, unknown methods and empty recipes', () => {
		const result = validateSetupManifest({
			steps: [{ ...ffmpeg, install: { windows: { brew: ['x'] }, darwin: { pkg: ['x'] }, linux: {} } }],
		});
		const text = result.errors.join('\n');
		expect(text).toMatch(/install\.windows is not a known OS/);
		expect(text).toMatch(/install\.darwin\.pkg is not a known install method/);
		expect(text).toMatch(/install\.linux lists no install method/);
	});

	it('only accepts script file names inside the skill directory', () => {
		const escape = { ...ffmpeg, install: { linux: { script: '../../evil.sh' } } };
		expect(validateSetupManifest({ steps: [escape] }).errors[0]).toMatch(/script must be a \.sh file name/);
		const ok = { ...ffmpeg, install: { linux: { script: 'install-whisper-cpp.sh' } } };
		expect(validateSetupManifest({ steps: [ok] }).valid).toBe(true);
	});

	it('requires some kind of check on a command step', () => {
		expect(validateSetupManifest({ steps: [{ ...ffmpeg, check: {} }] }).errors).toContain('setup.steps[0].check needs commands, paths or shell');
	});

	it('validates file steps: https, sha256, size, home-relative destination', () => {
		const result = validateSetupManifest({
			steps: [{ ...model, url: 'http://x', sha256: 'ABC', sizeBytes: 0, dest: '/etc/passwd', alternatives: ['~/../x'] }],
		});
		const text = result.errors.join('\n');
		expect(text).toMatch(/url must be an https URL/);
		expect(text).toMatch(/sha256 must be 64/);
		expect(text).toMatch(/sizeBytes must be a positive integer/);
		expect(text).toMatch(/dest must start with/);
		expect(text).toMatch(/alternatives\[0\] must start with/);
	});

	it('validates python steps: pip specs and import names are required', () => {
		expect(validateSetupManifest({ steps: [{ id: 'p', type: 'python', packages: [], imports: [] }] }).valid).toBe(false);
		const bad = validateSetupManifest({ steps: [{ id: 'p', type: 'python', packages: ['x && y'], imports: ['os;'], venv: 'Bad Name' }] });
		const text = bad.errors.join('\n');
		expect(text).toMatch(/packages: invalid entry/);
		expect(text).toMatch(/imports: invalid entry/);
		expect(text).toMatch(/venv must be kebab-case/);
	});

	it('rejects unknown step types', () => {
		expect(validateSetupManifest({ steps: [{ id: 'x', type: 'npm' }] }).errors[0]).toMatch(/type must be one of/);
	});

	it.each([
		['transcribe-audio', 'config/skills/agent/transcribe-audio/skill.json'],
		['pdf-tools', 'config/skills/agent/pdf-tools/skill.json'],
	])('the shipped %s setup block is valid', (_id, rel) => {
		const skill = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf-8')) as { setup?: unknown };
		const result = validateSetupManifest(skill.setup);
		expect(result.errors).toEqual([]);
	});
});

describe('recipeFor', () => {
	const step = {
		id: 'x',
		type: 'command',
		check: { commands: ['x'] },
		install: { darwin: { brew: ['x'] }, linux: { script: 'install-x.sh' } },
	} as CommandStep;

	it('falls back from debian to linux', () => {
		expect(recipeLookupOrder('debian')).toEqual(['debian', 'linux']);
		expect(recipeFor(step, 'debian')).toEqual({ script: 'install-x.sh' });
	});

	it('prefers the debian recipe when there is one', () => {
		const withDebian = { ...step, install: { ...step.install, debian: { apt: ['x'] } } } as CommandStep;
		expect(recipeFor(withDebian, 'debian')).toEqual({ apt: ['x'] });
	});

	it('returns undefined when the OS has no recipe', () => {
		expect(recipeFor({ ...step, install: { darwin: { brew: ['x'] } } } as CommandStep, 'linux')).toBeUndefined();
	});
});
