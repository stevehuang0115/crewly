/**
 * Tests for WhatsApp connection config persistence
 *
 * @module services/whatsapp/whatsapp-connection-config.test
 */

import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  getConnectionConfigPath,
  loadWhatsAppConnection,
  saveWhatsAppConnection,
  markWhatsAppDisconnected,
  toWhatsAppConfig,
} from './whatsapp-connection-config.js';

describe('WhatsApp connection config', () => {
  const originalHome = process.env.CREWLY_HOME;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
    process.env.CREWLY_HOME = tmp;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CREWLY_HOME;
    else process.env.CREWLY_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('lives under CREWLY_HOME/whatsapp', () => {
    expect(getConnectionConfigPath()).toBe(path.join(tmp, 'whatsapp', 'connection.json'));
  });

  it('returns null when nothing is persisted', async () => {
    expect(await loadWhatsAppConnection()).toBeNull();
  });

  it('round-trips a saved connection with auto-connect on, owner-only', async () => {
    await saveWhatsAppConnection({ allowedContacts: ['+1'], phoneNumber: '+49', authStatePath: '/a' }, 'inbox');
    const loaded = await loadWhatsAppConnection();
    expect(loaded).toEqual(
      expect.objectContaining({ mode: 'inbox', autoConnect: true, allowedContacts: ['+1'], phoneNumber: '+49', authStatePath: '/a' }),
    );
    expect(statSync(getConnectionConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('keeps the mode but turns auto-connect off on disconnect', async () => {
    await saveWhatsAppConnection({}, 'inbox');
    await markWhatsAppDisconnected();
    expect(await loadWhatsAppConnection()).toEqual(expect.objectContaining({ mode: 'inbox', autoConnect: false }));
  });

  it('disconnect without a saved config is a no-op', async () => {
    await expect(markWhatsAppDisconnected()).resolves.toBeUndefined();
    expect(await loadWhatsAppConnection()).toBeNull();
  });

  it('treats malformed or invalid-mode files as absent', async () => {
    mkdirSync(path.dirname(getConnectionConfigPath()), { recursive: true });
    writeFileSync(getConnectionConfigPath(), '{not json');
    expect(await loadWhatsAppConnection()).toBeNull();
    writeFileSync(getConnectionConfigPath(), JSON.stringify({ mode: 'autopilot', autoConnect: true }));
    expect(await loadWhatsAppConnection()).toBeNull();
    writeFileSync(getConnectionConfigPath(), JSON.stringify({ mode: 'assistant', allowedContacts: ['+1', 2] }));
    expect(await loadWhatsAppConnection()).toEqual(
      expect.objectContaining({ mode: 'assistant', autoConnect: false, allowedContacts: ['+1'], updatedAt: 0 }),
    );
    expect(JSON.parse(readFileSync(getConnectionConfigPath(), 'utf8')).mode).toBe('assistant');
  });

  it('converts to a service config', () => {
    expect(toWhatsAppConfig({ mode: 'inbox', autoConnect: true, allowedContacts: ['+1'], updatedAt: 1 })).toEqual({
      mode: 'inbox',
      allowedContacts: ['+1'],
      phoneNumber: undefined,
      authStatePath: undefined,
    });
  });
});
