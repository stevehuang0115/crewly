import { TL_DELEGATION_CONSTANTS as C } from '../../constants.js';
import { ThreadAnswerLog, getThreadAnswerLog, installThreadAnswerLog, setThreadAnswerLog } from './thread-answer-log.js';
import { reportOwnerThreadAgentPost } from './owner-thread-sentinel.service.js';

describe('ThreadAnswerLog', () => {
  let clock: number;
  let log: ThreadAnswerLog;
  const post = (agent: string, text = 'hello', threadTs: string | null = '1.1') => ({ agent, slackChannelId: 'C1', ...(threadTs ? { threadTs } : {}), text });

  beforeEach(() => {
    clock = 1_000_000;
    log = new ThreadAnswerLog(() => clock);
  });

  it('returns posts newer than the owner message, by others, oldest first', () => {
    clock += 10;
    log.record(post('luna', 'one'));
    clock += 10;
    log.record(post('kai', 'two'));
    expect(log.answersSince('C1:1.1', 1_000_000, 'ella').map((p) => p.agent)).toEqual(['luna', 'kai']);
  });

  it('skips the delegator and posts at or before the owner message', () => {
    log.record(post('luna'));
    clock += 10;
    log.record(post('ella'));
    expect(log.answersSince('C1:1.1', 1_000_000, 'ella')).toEqual([]);
    expect(log.answersSince('C1:1.1', 1_000_000, 'ella').length).toBe(0);
  });

  it('skips the target: handing the answerer its follow-up is not a second answer', () => {
    clock += 10;
    log.record(post('luna'));
    expect(log.answersSince('C1:1.1', 1_000_000, 'ella', 'luna')).toEqual([]);
    expect(log.answersSince('C1:1.1', 1_000_000, 'ella').map((p) => p.agent)).toEqual(['luna']);
  });

  it('ignores posts with no thread and keeps threads apart', () => {
    clock += 10;
    log.record(post('luna', 'x', null));
    log.record(post('luna', 'y', '2.2'));
    expect(log.answersSince('C1:1.1', 0, 'ella')).toEqual([]);
    expect(log.answersSince('C1:2.2', 0, 'ella')).toHaveLength(1);
  });

  it('clips the preview to one line', () => {
    clock += 10;
    log.record(post('luna', `line1\n${'x'.repeat(500)}`));
    const [p] = log.answersSince('C1:1.1', 0);
    expect(p.preview.includes('\n')).toBe(false);
    expect(p.preview.length).toBeLessThanOrEqual(C.THREAD_POST_PREVIEW_CHARS);
  });

  it('forgets posts after the TTL and caps posts per thread', () => {
    clock += 10;
    log.record(post('luna'));
    clock += C.THREAD_POST_TTL_MS + 1;
    expect(log.answersSince('C1:1.1', 0)).toEqual([]);
    for (let i = 0; i < C.THREAD_POSTS_KEPT + 5; i++) {
      clock += 1;
      log.record(post(`a${i}`));
    }
    expect(log.answersSince('C1:1.1', 0)).toHaveLength(C.THREAD_POSTS_KEPT);
  });

  it('keeps at most THREAD_LOG_MAX_THREADS threads (oldest dropped)', () => {
    clock += 10;
    for (let i = 0; i < C.THREAD_LOG_MAX_THREADS + 3; i++) log.record(post('luna', 'x', `${i + 1}.1`));
    expect(log.answersSince('C1:1.1', 0)).toEqual([]);
    expect(log.answersSince(`C1:${C.THREAD_LOG_MAX_THREADS + 3}.1`, 0)).toHaveLength(1);
  });

  describe('install', () => {
    afterEach(() => setThreadAnswerLog(null));

    it('records every agent post reported by the Slack post path', () => {
      setThreadAnswerLog(null);
      const installed = installThreadAnswerLog();
      expect(getThreadAnswerLog()).toBe(installed);
      expect(installThreadAnswerLog()).toBe(installed);
      reportOwnerThreadAgentPost({ agent: 'luna-install-test', slackChannelId: 'C9', threadTs: '9.9', text: 'via reply --work-item' });
      expect(installed.answersSince('C9:9.9', 0, 'ella').map((p) => p.agent)).toEqual(['luna-install-test']);
    });
  });
});
