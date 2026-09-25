import { inboundFileHint, isAudioOrVideo, isPdf } from './inbound-file-hint.utils.js';

describe('inbound file hints', () => {
	it('recognises audio/video by MIME type or extension', () => {
		expect(isAudioOrVideo({ name: 'Audio Clip.m4a', mimetype: 'audio/mp4' })).toBe(true);
		expect(isAudioOrVideo({ name: 'clip', mimetype: 'video/quicktime' })).toBe(true);
		expect(isAudioOrVideo({ name: 'voice.OPUS', mimetype: 'application/octet-stream' })).toBe(true);
		expect(isAudioOrVideo({ name: 'notes.txt', mimetype: 'text/plain' })).toBe(false);
	});

	it('recognises PDFs', () => {
		expect(isPdf({ name: 'x', mimetype: 'application/pdf' })).toBe(true);
		expect(isPdf({ name: 'Contract.PDF', mimetype: 'application/octet-stream' })).toBe(true);
		expect(isPdf({ name: 'a.docx', mimetype: 'application/msword' })).toBe(false);
	});

	it('points a voice message at transcribe-audio, with the path and what to do if it is not set up', () => {
		const hint = inboundFileHint({ name: 'Audio Clip.m4a', mimetype: 'audio/mp4', localPath: '/home/u/.crewly/tmp/slack-files/F1-Audio_Clip.m4a' });
		expect(hint).toBe(
			'[Hint: voice/audio or video file — use the transcribe-audio skill: {"audioFile":"/home/u/.crewly/tmp/slack-files/F1-Audio_Clip.m4a"}. ' +
				'If it answers "needsSetup": true, tell the user you are setting up transcription and run install-skill --id transcribe-audio — do not just say you cannot.]',
		);
	});

	it('adds no PDF hint when the full text is already inline', () => {
		expect(inboundFileHint({ name: 'a.pdf', mimetype: 'application/pdf', localPath: '/t/a.pdf', extractedText: 'all of it' })).toBeNull();
	});

	it('points at the PDF reading skill when extraction failed or was cut short', () => {
		expect(inboundFileHint({ name: 'a.pdf', mimetype: 'application/pdf', localPath: '/t/a.pdf' })).toBe(
			'[Hint: PDF — its text could not be extracted here; use the PDF reading skill (pdf-tools): {"action":"read","input":"/t/a.pdf"}.]',
		);
		expect(inboundFileHint({ name: 'a.pdf', mimetype: 'application/pdf', localPath: '/t/a.pdf', extractedText: 'start…\n... [truncated]' })).toMatch(
			/^\[Hint: PDF — only the start of its text is included above; use the PDF reading skill \(pdf-tools\)/,
		);
	});

	it('escapes paths as JSON and ignores other files', () => {
		expect(inboundFileHint({ name: 'a "b".mp3', mimetype: 'audio/mpeg', localPath: '/t/a "b".mp3' })).toContain('{"audioFile":"/t/a \\"b\\".mp3"}');
		expect(inboundFileHint({ name: 'sheet.xlsx', mimetype: 'application/vnd.ms-excel', localPath: '/t/s.xlsx' })).toBeNull();
	});
});
