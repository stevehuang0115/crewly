/**
 * Tests for the API-key read scoping (#1024).
 */

const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: mockInfo, warn: mockWarn, error: jest.fn(), debug: jest.fn() }),
    }),
  },
}));

const mockGetSkill = jest.fn();
jest.mock('../skill/skill.service.js', () => ({
  getSkillService: () => ({ getSkill: mockGetSkill }),
}));

const mockFindMember = jest.fn();
const mockOrcStatus = jest.fn();
jest.mock('../core/storage.service.js', () => ({
  StorageService: {
    getInstance: () => ({ findMemberBySessionName: mockFindMember, getOrchestratorStatus: mockOrcStatus }),
  },
}));

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  API_KEY_ACCESS_ERRORS,
  RUNTIME_KEY_PROVIDERS,
  decideAgentApiKeyAccess,
  defaultAgentProfile,
  defaultSkillProfile,
  logApiKeyRead,
  providerForEnvVar,
} from './api-key-access.service.js';

describe('api-key-access (#1024)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('providerForEnvVar', () => {
    it('maps every provider env var', () => {
      expect(providerForEnvVar('OPENAI_API_KEY')).toBe('openai');
      expect(providerForEnvVar('GEMINI_API_KEY')).toBe('gemini');
      expect(providerForEnvVar('GOOGLE_GENERATIVE_AI_API_KEY')).toBe('gemini');
      expect(providerForEnvVar('ANTHROPIC_API_KEY')).toBe('anthropic');
      expect(providerForEnvVar('DEEPSEEK_API_KEY')).toBe('deepseek');
      expect(providerForEnvVar('BRAVE_API_KEY')).toBeUndefined();
    });
  });

  describe('decideAgentApiKeyAccess', () => {
    const profiles = {
      agentProfile: async () => ({ runtime: 'claude-code', role: 'developer' }),
      skillProfile: async (id: string) =>
        id === 'transcribe-audio' ? { providers: ['openai' as const], assignableRoles: ['*'] }
          : id === 'qa-only' ? { providers: ['gemini' as const], assignableRoles: ['qa'] }
            : null,
    };

    it('allows the runtime\'s own provider and resolves with the agent\'s runtime', async () => {
      expect(await decideAgentApiKeyAccess('s', 'anthropic', {}, profiles)).toEqual({ allowed: true, runtime: 'claude-code' });
    });

    it('refuses another provider without a skill', async () => {
      const d = await decideAgentApiKeyAccess('s', 'openai', {}, profiles);
      expect(d).toMatchObject({ allowed: false, code: API_KEY_ACCESS_ERRORS.OUT_OF_SCOPE });
    });

    it('refuses a runtime other than the agent\'s, even with a matching skill', async () => {
      const d = await decideAgentApiKeyAccess('s', 'openai', { runtime: 'codex-cli', skill: 'transcribe-audio' }, profiles);
      expect(d).toMatchObject({ allowed: false, code: API_KEY_ACCESS_ERRORS.RUNTIME_MISMATCH });
    });

    it('accepts ?runtime= naming the agent\'s own runtime', async () => {
      expect((await decideAgentApiKeyAccess('s', 'anthropic', { runtime: 'claude-code' }, profiles)).allowed).toBe(true);
    });

    it('allows a provider the named skill declares', async () => {
      expect(await decideAgentApiKeyAccess('s', 'openai', { skill: 'transcribe-audio' }, profiles)).toEqual({
        allowed: true,
        skill: 'transcribe-audio',
        runtime: 'claude-code',
      });
    });

    it('refuses an undeclared provider, an unknown skill and a skill for another role', async () => {
      expect(await decideAgentApiKeyAccess('s', 'anthropic', { skill: 'transcribe-audio' }, profiles)).toMatchObject({ code: API_KEY_ACCESS_ERRORS.OUT_OF_SCOPE });
      expect(await decideAgentApiKeyAccess('s', 'openai', { skill: 'nope' }, profiles)).toMatchObject({ code: API_KEY_ACCESS_ERRORS.UNKNOWN_SKILL });
      expect(await decideAgentApiKeyAccess('s', 'gemini', { skill: 'qa-only' }, profiles)).toMatchObject({ code: API_KEY_ACCESS_ERRORS.SKILL_NOT_FOR_ROLE });
    });

    it('refuses everything but a declared skill for a session with no known runtime', async () => {
      const unknown = { ...profiles, agentProfile: async () => ({}) };
      expect((await decideAgentApiKeyAccess('s', 'anthropic', {}, unknown)).allowed).toBe(false);
      expect((await decideAgentApiKeyAccess('s', 'openai', { skill: 'transcribe-audio' }, unknown)).allowed).toBe(true);
    });

    it('scopes each runtime to the providers it consumes', () => {
      expect(RUNTIME_KEY_PROVIDERS['claude-code']).toEqual(['anthropic']);
      expect(RUNTIME_KEY_PROVIDERS['codex-cli']).toEqual(['openai']);
      expect(RUNTIME_KEY_PROVIDERS['gemini-cli']).toEqual(['gemini']);
      expect(RUNTIME_KEY_PROVIDERS['crewly-agent']).toContain('deepseek');
    });
  });

  describe('defaultAgentProfile', () => {
    it('reads a team member\'s runtime and role', async () => {
      mockFindMember.mockResolvedValue({ team: {}, member: { role: 'developer', runtimeType: 'codex-cli' } });
      expect(await defaultAgentProfile('crewly-dev-sam')).toEqual({ role: 'developer', runtime: 'codex-cli' });
    });

    it('reads the orchestrator\'s runtime', async () => {
      mockOrcStatus.mockResolvedValue({ runtimeType: 'claude-code' });
      expect(await defaultAgentProfile('crewly-orc')).toEqual({ role: 'orchestrator', runtime: 'claude-code' });
    });

    it('knows nothing about a session that is neither', async () => {
      mockFindMember.mockResolvedValue(null);
      expect(await defaultAgentProfile('workitem-dispatch')).toEqual({});
    });
  });

  describe('defaultSkillProfile', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-key-access-'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('collects requires / optionalSecrets from skill.json and SKILL.md, by the short or catalog id', async () => {
      await fs.writeFile(path.join(dir, 'skill.json'), JSON.stringify({ requires: ['GEMINI_API_KEY'], optionalSecrets: ['BRAVE_API_KEY'] }));
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\noptionalSecrets:\n  - OPENAI_API_KEY\n---\nbody\n');
      mockGetSkill.mockImplementation(async (id: string) =>
        id === 'skill-x' ? { promptFile: path.join(dir, 'SKILL.md'), assignableRoles: ['*'] } : null,
      );
      const profile = await defaultSkillProfile('x');
      expect(profile?.providers.sort()).toEqual(['gemini', 'openai']);
      expect(profile?.assignableRoles).toEqual(['*']);
    });

    it('is null for no such skill', async () => {
      mockGetSkill.mockResolvedValue(null);
      expect(await defaultSkillProfile('nope')).toBeNull();
    });

    it('declares nothing when the manifests carry no secrets', async () => {
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
      mockGetSkill.mockResolvedValue({ promptFile: path.join(dir, 'SKILL.md'), assignableRoles: [] });
      expect((await defaultSkillProfile('x'))?.providers).toEqual([]);
    });
  });

  describe('logApiKeyRead', () => {
    it('logs reads at info and refusals at warn, never a key', () => {
      logApiKeyRead({ provider: 'openai', identity: { kind: 'agent', via: 'agent-badge', session: 's' }, skill: 'transcribe-audio', outcome: 'served' });
      expect(mockInfo).toHaveBeenCalledWith('API key read', expect.objectContaining({ provider: 'openai', session: 's', skill: 'transcribe-audio', outcome: 'served' }));
      logApiKeyRead({ provider: 'gemini', identity: { kind: 'anonymous', via: 'none' }, outcome: 'refused', code: 'x' });
      expect(mockWarn).toHaveBeenCalledWith('API key read refused', expect.objectContaining({ provider: 'gemini', caller: 'anonymous', code: 'x' }));
      for (const call of [...mockInfo.mock.calls, ...mockWarn.mock.calls]) {
        expect(Object.keys(call[1])).not.toContain('key');
      }
    });
  });
});
