
import { logger } from './logger';

describe('logger', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should log info messages', () => {
    logger.info('test message', { foo: 'bar' });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'INFO',
      message: 'test message',
      data: { foo: 'bar' },
    });
  });

  it('should log warn messages', () => {
    logger.warn('test warning', { baz: 'qux' });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'WARN',
      message: 'test warning',
      data: { baz: 'qux' },
    });
  });

  it('should log error messages', () => {
    logger.error('test error', { err: 'something bad' });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'ERROR',
      message: 'test error',
      data: { err: 'something bad' },
    });
  });
});
