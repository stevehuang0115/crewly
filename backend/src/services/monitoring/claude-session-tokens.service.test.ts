/**
 * Tests for the Claude Code project-slug helpers in claude-session-tokens.
 *
 * Uses a real temp tree with a real symlink: the bug these guard against
 * (#938) is that Claude Code files transcripts under the *resolved* cwd, and
 * only a real filesystem shows whether the lookup resolves it.
 *
 * @module services/monitoring/claude-session-tokens.service.test
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
	encodeProjectSlug,
	findLatestSessionFile,
	findSessionJsonlPath,
	listProjectTranscripts,
	resolveProjectDirCandidates,
	resolveProjectSlugCandidates,
} from './claude-session-tokens.service.js';

describe('claude-session-tokens project slug helpers', () => {
	let tmpRoot: string;
	let realCwd: string;
	let linkedCwd: string;
	let projectsDir: string;

	beforeEach(async () => {
		// realpath the root so a symlinked os.tmpdir() (macOS) does not muddy
		// which slug is "raw" and which is "resolved".
		tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-slug-')));
		realCwd = path.join(tmpRoot, 'private', 'proj');
		await fs.mkdir(realCwd, { recursive: true });
		await fs.symlink(path.join(tmpRoot, 'private'), path.join(tmpRoot, 'tmp'), 'dir');
		linkedCwd = path.join(tmpRoot, 'tmp', 'proj');
		projectsDir = path.join(tmpRoot, '.claude', 'projects');
	});

	afterEach(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	describe('encodeProjectSlug', () => {
		it('replaces slashes and dots with dashes', () => {
			expect(encodeProjectSlug('/Users/alice/.crewly')).toBe('-Users-alice--crewly');
		});
	});

	describe('resolveProjectSlugCandidates', () => {
		it('puts the resolved slug before the raw slug for a symlinked cwd', async () => {
			expect(await resolveProjectSlugCandidates(linkedCwd)).toEqual([
				encodeProjectSlug(realCwd),
				encodeProjectSlug(linkedCwd),
			]);
		});

		it('returns a single slug for a cwd with no symlink', async () => {
			expect(await resolveProjectSlugCandidates(realCwd)).toEqual([encodeProjectSlug(realCwd)]);
		});

		it('falls back to the raw slug without throwing when the cwd does not exist', async () => {
			const missing = path.join(tmpRoot, 'gone', 'proj');
			await expect(resolveProjectSlugCandidates(missing)).resolves.toEqual([encodeProjectSlug(missing)]);
		});
	});

	describe('resolveProjectDirCandidates', () => {
		it('places each slug under <home>/.claude/projects', async () => {
			expect(await resolveProjectDirCandidates(linkedCwd, tmpRoot)).toEqual([
				path.join(projectsDir, encodeProjectSlug(realCwd)),
				path.join(projectsDir, encodeProjectSlug(linkedCwd)),
			]);
		});
	});

	describe('transcript lookup', () => {
		const ID = '0d7819e4-c359-4ce4-b429-838b38d9642e';

		/** Writes an empty transcript into the given slug dir and returns its path. */
		async function writeTranscript(slug: string, id: string): Promise<string> {
			const dir = path.join(projectsDir, slug);
			await fs.mkdir(dir, { recursive: true });
			const file = path.join(dir, `${id}.jsonl`);
			await fs.writeFile(file, '{}\n');
			return file;
		}

		it('finds a transcript Claude Code filed under the resolved slug', async () => {
			const file = await writeTranscript(encodeProjectSlug(realCwd), ID);

			expect(await findSessionJsonlPath(linkedCwd, ID, tmpRoot)).toBe(file);
			expect(await findLatestSessionFile(linkedCwd, tmpRoot)).toBe(file);
		});

		it('still finds a transcript under the raw slug', async () => {
			const file = await writeTranscript(encodeProjectSlug(linkedCwd), ID);

			expect(await findSessionJsonlPath(linkedCwd, ID, tmpRoot)).toBe(file);
		});

		it('works for a non-symlinked cwd', async () => {
			const file = await writeTranscript(encodeProjectSlug(realCwd), ID);

			expect(await findSessionJsonlPath(realCwd, ID, tmpRoot)).toBe(file);
			expect(await findLatestSessionFile(realCwd, tmpRoot)).toBe(file);
		});

		it('returns null rather than throwing for a nonexistent cwd with no transcripts', async () => {
			const missing = path.join(tmpRoot, 'gone');

			await expect(findSessionJsonlPath(missing, ID, tmpRoot)).resolves.toBeNull();
			await expect(findLatestSessionFile(missing, tmpRoot)).resolves.toBeNull();
		});

		it('finds a transcript under the raw slug for a nonexistent cwd', async () => {
			const missing = path.join(tmpRoot, 'gone');
			const file = await writeTranscript(encodeProjectSlug(missing), ID);

			expect(await findSessionJsonlPath(missing, ID, tmpRoot)).toBe(file);
		});

		it('merges both slug directories and picks the newest transcript overall', async () => {
			const older = await writeTranscript(encodeProjectSlug(realCwd), 'older');
			const newer = await writeTranscript(encodeProjectSlug(linkedCwd), 'newer');
			await fs.utimes(older, new Date(1_000_000), new Date(1_000_000));
			await fs.utimes(newer, new Date(2_000_000), new Date(2_000_000));

			expect((await listProjectTranscripts(linkedCwd, tmpRoot)).sort()).toEqual([newer, older].sort());
			expect(await findLatestSessionFile(linkedCwd, tmpRoot)).toBe(newer);
		});

		it('lists a conversation once when it appears under both slugs, preferring the resolved one', async () => {
			const resolved = await writeTranscript(encodeProjectSlug(realCwd), ID);
			await writeTranscript(encodeProjectSlug(linkedCwd), ID);

			expect(await listProjectTranscripts(linkedCwd, tmpRoot)).toEqual([resolved]);
			expect(await findSessionJsonlPath(linkedCwd, ID, tmpRoot)).toBe(resolved);
		});
	});
});
