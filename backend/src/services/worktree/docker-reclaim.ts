/**
 * Docker reclaim for the low-disk pass.
 *
 * Agents that deploy build images on this machine all day; Docker Desktop's
 * disk grew 23 GB in one night (2026-10-07) and took the Mac to 2.3 GB free
 * while the worktree janitor found "nothing safe to delete". Only things that
 * can be rebuilt or pulled again are removed:
 *
 *   - older tags of registry images (`host/repo:tag`) — the newest tag of
 *     each repository stays, so the next build still has its layers; an image
 *     a container uses cannot be removed (docker refuses, we move on)
 *   - dangling images
 *   - build cache beyond a few GB, for the default builder and every
 *     docker-container (buildx) builder
 *
 * Never volumes, never containers. Skipped when the docker CLI or daemon is
 * not there. Never throws.
 *
 * @module services/worktree/docker-reclaim
 */

import { execFile } from 'child_process';

/** Runs a docker command; resolves stdout, rejects on failure. */
export type DockerExec = (args: string[], timeoutMs: number) => Promise<string>;

/** What a reclaim did. */
export interface DockerReclaimResult {
	/** Docker was reachable */
	ran: boolean;
	/** Image tags removed */
	removedImages: string[];
}

/** Build cache kept per builder. */
export const DOCKER_RECLAIM_KEEP_STORAGE = '3gb';

const defaultExec: DockerExec = (args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			if (err) reject(err);
			else resolve(String(stdout));
		});
	});

/**
 * Older tags of each registry repository, newest first in `docker images`
 * output (which lists newest first).
 *
 * @param listing - `docker images --format '{{.Repository}} {{.Tag}}'` output
 * @returns `repo:tag` names to remove
 */
export function olderRegistryTags(listing: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of listing.split('\n')) {
		const [repo, tag] = line.trim().split(/\s+/);
		if (!repo || !tag || tag === '<none>' || repo === '<none>') continue;
		// Only images that live in a registry (`host/...`): they can be pulled again.
		if (!repo.includes('/') || !repo.split('/')[0].includes('.')) continue;
		if (seen.has(repo)) out.push(`${repo}:${tag}`);
		else seen.add(repo);
	}
	return out;
}

/**
 * Names of docker-container (buildx) builders.
 *
 * @param listing - `docker buildx ls` output
 * @returns Builder names
 */
export function containerBuilders(listing: string): string[] {
	const out: string[] = [];
	for (const line of listing.split('\n')) {
		if (/^\s|\\_/.test(line)) continue;
		const [name, driver] = line.trim().split(/\s+/);
		if (name && driver === 'docker-container') out.push(name.replace(/\*$/, ''));
	}
	return out;
}

/**
 * Free what Docker holds that can be rebuilt or pulled again.
 *
 * @param exec - docker runner (tests)
 * @returns What was done
 */
export async function reclaimDocker(exec: DockerExec = defaultExec): Promise<DockerReclaimResult> {
	const result: DockerReclaimResult = { ran: false, removedImages: [] };
	try {
		await exec(['info', '--format', '{{.ServerVersion}}'], 15_000);
	} catch {
		return result;
	}
	result.ran = true;
	const listing = await exec(['images', '--format', '{{.Repository}} {{.Tag}}'], 30_000).catch(() => '');
	for (const ref of olderRegistryTags(listing)) {
		const ok = await exec(['rmi', ref], 60_000).then(() => true, () => false);
		if (ok) result.removedImages.push(ref);
	}
	await exec(['image', 'prune', '-f'], 120_000).catch(() => '');
	await exec(['builder', 'prune', '-f', '--keep-storage', DOCKER_RECLAIM_KEEP_STORAGE], 300_000).catch(() => '');
	const builders = containerBuilders(await exec(['buildx', 'ls'], 30_000).catch(() => ''));
	for (const b of builders) {
		await exec(['buildx', 'prune', '--builder', b, '-f', '--keep-storage', DOCKER_RECLAIM_KEEP_STORAGE], 300_000).catch(() => '');
	}
	return result;
}
