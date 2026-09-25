/**
 * getTemplatesDir against the real filesystem: a global npm install runs the
 * CLI through a `bin` symlink that lives outside the package.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getTemplatesDir } from './templates.js';

describe('getTemplatesDir (global install through a bin symlink)', () => {
	let tmp: string;
	let originalArgv1: string;
	let originalCwd: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-templates-dir-')));
		originalArgv1 = process.argv[1];
		originalCwd = process.cwd();
	});

	afterEach(() => {
		process.argv[1] = originalArgv1;
		process.chdir(originalCwd);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('follows the bin symlink into the package instead of falling back to the cwd', () => {
		// <prefix>/lib/node_modules/crewly/{config/templates, dist/cli/index.js}
		const pkg = path.join(tmp, 'prefix', 'lib', 'node_modules', 'crewly');
		fs.mkdirSync(path.join(pkg, 'config', 'templates'), { recursive: true });
		fs.mkdirSync(path.join(pkg, 'dist', 'cli'), { recursive: true });
		fs.writeFileSync(path.join(pkg, 'dist', 'cli', 'index.js'), '');
		// <prefix>/bin/crewly -> ../lib/node_modules/crewly/dist/cli/index.js
		const binDir = path.join(tmp, 'prefix', 'bin');
		fs.mkdirSync(binDir, { recursive: true });
		const bin = path.join(binDir, 'crewly');
		fs.symlinkSync(path.join(pkg, 'dist', 'cli', 'index.js'), bin);
		const unrelatedCwd = path.join(tmp, 'work');
		fs.mkdirSync(unrelatedCwd);

		process.argv[1] = bin;
		process.chdir(unrelatedCwd);

		expect(getTemplatesDir()).toBe(path.join(pkg, 'config', 'templates'));
	});
});
