/**
 * Tests for UserProfileService
 *
 * Uses a temporary directory to avoid touching the real ~/.crewly.
 *
 * @module services/memory/user-profile.service.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserProfileService } from './user-profile.service.js';

describe('UserProfileService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-user-profile-test-'));
    UserProfileService.clearInstance();
  });

  afterEach(() => {
    UserProfileService.clearInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getInstance', () => {
    it('should return the same singleton instance on repeated calls', () => {
      const a = UserProfileService.getInstance(tmpDir);
      const b = UserProfileService.getInstance(tmpDir);
      expect(a).toBe(b);
    });
  });

  describe('clearInstance', () => {
    it('should reset singleton so next getInstance creates a new instance', () => {
      const a = UserProfileService.getInstance(tmpDir);
      UserProfileService.clearInstance();
      const b = UserProfileService.getInstance(tmpDir);
      expect(a).not.toBe(b);
    });
  });

  describe('getProfile', () => {
    it('should return empty object when no profile file exists', async () => {
      const service = new UserProfileService(tmpDir);
      const profile = await service.getProfile();
      expect(profile).toEqual({});
    });

    it('should return profile data when file exists', async () => {
      const profileDir = path.join(tmpDir, '.crewly');
      fs.mkdirSync(profileDir, { recursive: true });
      const profileData = { language: 'zh-CN', timezone: 'Asia/Shanghai' };
      fs.writeFileSync(path.join(profileDir, 'user-profile.json'), JSON.stringify(profileData), 'utf-8');

      const service = new UserProfileService(tmpDir);
      const profile = await service.getProfile();
      expect(profile.language).toBe('zh-CN');
      expect(profile.timezone).toBe('Asia/Shanghai');
    });

    it('should return cached profile on subsequent calls within TTL', async () => {
      const service = new UserProfileService(tmpDir);

      // First call creates cache
      await service.updateProfile({ language: 'en' }, 'test');
      const p1 = await service.getProfile();

      // Modify file directly (bypassing service)
      const profilePath = path.join(tmpDir, '.crewly', 'user-profile.json');
      fs.writeFileSync(profilePath, JSON.stringify({ language: 'fr' }), 'utf-8');

      // Should still return cached value
      const p2 = await service.getProfile();
      expect(p2.language).toBe('en');
      expect(p1).toEqual(p2);
    });
  });

  describe('updateProfile', () => {
    it('should create file and return the profile on first update', async () => {
      const service = new UserProfileService(tmpDir);
      const result = await service.updateProfile(
        { language: 'zh-CN', reportingStyle: 'concise' },
        'crewly-orc',
      );

      expect(result.language).toBe('zh-CN');
      expect(result.reportingStyle).toBe('concise');
      expect(result.updatedBy).toBe('crewly-orc');
      expect(result.updatedAt).toBeDefined();

      // Verify file was written
      const filePath = path.join(tmpDir, '.crewly', 'user-profile.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should merge partial updates preserving existing fields', async () => {
      const service = new UserProfileService(tmpDir);

      await service.updateProfile({ language: 'zh-CN', timezone: 'Asia/Shanghai' }, 'user');
      const result = await service.updateProfile({ reportingStyle: 'detailed' }, 'crewly-orc');

      expect(result.language).toBe('zh-CN');
      expect(result.timezone).toBe('Asia/Shanghai');
      expect(result.reportingStyle).toBe('detailed');
      expect(result.updatedBy).toBe('crewly-orc');
    });

    it('should append notes without duplicates', async () => {
      const service = new UserProfileService(tmpDir);

      await service.updateProfile({ notes: ['Note A', 'Note B'] }, 'user');
      const result = await service.updateProfile({ notes: ['Note B', 'Note C'] }, 'user');

      expect(result.notes).toEqual(['Note A', 'Note B', 'Note C']);
    });

    it('should append prohibitions without duplicates', async () => {
      const service = new UserProfileService(tmpDir);

      await service.updateProfile({ prohibitions: ['no emojis', 'no jargon'] }, 'user');
      const result = await service.updateProfile({ prohibitions: ['no jargon', 'no slang'] }, 'user');

      expect(result.prohibitions).toEqual(['no emojis', 'no jargon', 'no slang']);
    });

    it('should deep merge preferences preserving existing keys', async () => {
      const service = new UserProfileService(tmpDir);

      await service.updateProfile({ preferences: { editor: 'vim', theme: 'dark' } }, 'user');
      const result = await service.updateProfile({ preferences: { theme: 'light', font: 'mono' } }, 'user');

      expect(result.preferences).toEqual({ editor: 'vim', theme: 'light', font: 'mono' });
    });
  });

  describe('generateProfileContext', () => {
    it('should return null when profile is empty', async () => {
      const service = new UserProfileService(tmpDir);
      const context = await service.generateProfileContext();
      expect(context).toBeNull();
    });

    it('should return null when profile only has metadata fields', async () => {
      const service = new UserProfileService(tmpDir);
      // Create profile with only updatedAt/updatedBy
      const profileDir = path.join(tmpDir, '.crewly');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'user-profile.json'),
        JSON.stringify({ updatedAt: '2026-01-01', updatedBy: 'test' }),
        'utf-8',
      );

      const context = await service.generateProfileContext();
      expect(context).toBeNull();
    });

    it('should return formatted string with all profile fields', async () => {
      const service = new UserProfileService(tmpDir);

      await service.updateProfile(
        {
          language: 'zh-CN',
          reportingStyle: 'detailed',
          riskTolerance: 'conservative',
          timezone: 'Asia/Shanghai',
          domainContext: 'fintech startup',
          prohibitions: ['no emojis', 'no slang'],
          preferences: { editor: 'vim', framework: 'express' },
          notes: ['Prefers async communication', 'Responds best to structured reports'],
        },
        'user',
      );

      const context = await service.generateProfileContext();
      expect(context).not.toBeNull();
      expect(context).toContain('## Shared User Profile');
      expect(context).toContain('**Language:** zh-CN');
      expect(context).toContain('**Reporting Style:** detailed');
      expect(context).toContain('**Risk Tolerance:** conservative');
      expect(context).toContain('**Timezone:** Asia/Shanghai');
      expect(context).toContain('**Domain:** fintech startup');
      expect(context).toContain('**Do NOT:**');
      expect(context).toContain('no emojis');
      expect(context).toContain('no slang');
      expect(context).toContain('**Preferences:**');
      expect(context).toContain('editor: vim');
      expect(context).toContain('framework: express');
      expect(context).toContain('**Notes:**');
      expect(context).toContain('Prefers async communication');
    });
  });
});
