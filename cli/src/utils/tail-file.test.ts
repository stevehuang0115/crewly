import fs from 'fs';
import os from 'os';
import path from 'path';
import { followCommand, NO_LOGS_TEXT, tailFile } from './tail-file.js';

describe('tailFile', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-tail-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	});

	it('returns the last lines, LF or CRLF', () => {
		const file = path.join(dir, 'a.log');
		fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\nfour\r\n');
		expect(tailFile(file, 2)).toBe('three\nfour');
		expect(tailFile(file, 10)).toBe('one\ntwo\nthree\nfour');
	});

	it('answers "No logs" for a missing file and nothing for an empty one', () => {
		expect(tailFile(path.join(dir, 'missing.log'), 5)).toBe(NO_LOGS_TEXT);
		const empty = path.join(dir, 'empty.log');
		fs.writeFileSync(empty, '');
		expect(tailFile(empty, 5)).toBe('');
	});
});

describe('followCommand', () => {
	it('uses tail -f on POSIX', () => {
		expect(followCommand(['/a.log', '/b.log'], 'linux')).toEqual({ command: 'tail', args: ['-f', '/a.log', '/b.log'] });
	});

	it('uses Get-Content -Wait on Windows, quoting each path', () => {
		const { command, args } = followCommand(["C:\\Users\\me\\.crewly\\it's.log"], 'win32');
		expect(command).toBe('powershell.exe');
		expect(args[args.length - 1]).toBe("Get-Content -LiteralPath 'C:\\Users\\me\\.crewly\\it''s.log' -Tail 10 -Wait");
	});
});
