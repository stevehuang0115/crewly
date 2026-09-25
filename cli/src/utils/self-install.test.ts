/**
 * Tests for the npm arguments of a Crewly self-upgrade.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isUnderUserPrefix, selfInstallArgs } from './self-install.js';

describe('selfInstallArgs', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-self-install-')));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('targets the user prefix when the running Crewly is installed there', () => {
		const prefix = path.join(tmp, '.crewly', 'npm-global');
		const root = path.join(prefix, 'lib', 'node_modules', 'crewly');
		fs.mkdirSync(root, { recursive: true });
		expect(selfInstallArgs('crewly@latest', root, prefix)).toEqual(['install', '-g', '--prefix', prefix, 'crewly@latest']);
	});

	it('uses a plain global install otherwise', () => {
		const prefix = path.join(tmp, '.crewly', 'npm-global');
		const root = path.join(tmp, 'usr', 'lib', 'node_modules', 'crewly');
		fs.mkdirSync(root, { recursive: true });
		expect(selfInstallArgs('crewly@latest', root, prefix)).toEqual(['install', '-g', 'crewly@latest']);
		expect(selfInstallArgs('crewly@latest', null, prefix)).toEqual(['install', '-g', 'crewly@latest']);
	});

	it('does not match a sibling directory that only shares the prefix string', () => {
		const prefix = path.join(tmp, 'npm-global');
		expect(isUnderUserPrefix(path.join(tmp, 'npm-global-old', 'lib', 'node_modules', 'crewly'), prefix)).toBe(false);
	});

	it('follows symlinks on either side', () => {
		const prefix = path.join(tmp, 'real-prefix');
		const root = path.join(prefix, 'lib', 'node_modules', 'crewly');
		fs.mkdirSync(root, { recursive: true });
		const link = path.join(tmp, 'link-prefix');
		fs.symlinkSync(prefix, link);
		expect(isUnderUserPrefix(path.join(link, 'lib', 'node_modules', 'crewly'), prefix)).toBe(true);
	});
});
