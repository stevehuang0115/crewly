/**
 * Tests for the local API URL accessor (#777).
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  getLocalApiBaseUrl,
  getLocalApiPort,
  parsePort,
  resetLocalApiPortForTesting,
  setLocalApiPort,
} from './local-api-url.utils.js';

describe('local-api-url utils', () => {
  const savedWebPort = process.env.WEB_PORT;
  const savedApiUrl = process.env.CREWLY_API_URL;

  beforeEach(() => {
    resetLocalApiPortForTesting();
    delete process.env.WEB_PORT;
    delete process.env.CREWLY_API_URL;
  });

  afterEach(() => {
    resetLocalApiPortForTesting();
    if (savedWebPort === undefined) delete process.env.WEB_PORT;
    else process.env.WEB_PORT = savedWebPort;
    if (savedApiUrl === undefined) delete process.env.CREWLY_API_URL;
    else process.env.CREWLY_API_URL = savedApiUrl;
  });

  it('an instance on port N hands out http://localhost:N', () => {
    setLocalApiPort(8797);
    expect(getLocalApiPort()).toBe(8797);
    expect(getLocalApiBaseUrl()).toBe('http://localhost:8797');
  });

  it('the running port wins over WEB_PORT', () => {
    process.env.WEB_PORT = '9000';
    setLocalApiPort(8797);
    expect(getLocalApiBaseUrl()).toBe('http://localhost:8797');
  });

  it('falls back to WEB_PORT before the server has recorded its port', () => {
    process.env.WEB_PORT = '8800';
    expect(getLocalApiBaseUrl()).toBe('http://localhost:8800');
  });

  it('falls back to the default port when nothing is set or WEB_PORT is invalid', () => {
    expect(getLocalApiPort()).toBe(8787);
    process.env.WEB_PORT = 'not-a-port';
    expect(getLocalApiPort()).toBe(8787);
  });

  it('ignores CREWLY_API_URL inherited by the backend process (it names another instance)', () => {
    process.env.CREWLY_API_URL = 'http://localhost:8787';
    setLocalApiPort(8797);
    expect(getLocalApiBaseUrl()).toBe('http://localhost:8797');
  });

  it('rejects an invalid port', () => {
    expect(() => setLocalApiPort(0)).toThrow('Invalid Crewly API port');
    expect(() => setLocalApiPort(70000)).toThrow();
    expect(() => setLocalApiPort(80.5)).toThrow();
  });

  describe('parsePort', () => {
    it('accepts integers and numeric strings in range', () => {
      expect(parsePort(8787)).toBe(8787);
      expect(parsePort(' 8797 ')).toBe(8797);
    });

    it('rejects everything else', () => {
      for (const bad of [undefined, null, '', 'abc', '0', '65536', -1, 1.5, {}]) {
        expect(parsePort(bad)).toBeNull();
      }
    });
  });
});
