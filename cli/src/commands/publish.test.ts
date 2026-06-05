/**
 * Publish Command Tests
 *
 * Tests for the crewly publish CLI command including validation,
 * dry-run mode, and archive creation.
 *
 * @module cli/commands/publish.test
 */

import { publishCommand } from './publish.js';

// Mock chalk to pass through strings
jest.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
    blue: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    gray: (s: string) => s,
  },
  red: (s: string) => s,
  blue: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  gray: (s: string) => s,
}));

// Mock package-validator
const mockValidate = jest.fn();
jest.mock('../utils/package-validator.js', () => ({
  validatePackage: (...args: unknown[]) => mockValidate(...args),
}));

// Mock archive-creator
const mockCreateArchive = jest.fn();
const mockGenerateChecksum = jest.fn();
const mockGenerateRegistryEntry = jest.fn();
jest.mock('../utils/archive-creator.js', () => ({
  createSkillArchive: (...args: unknown[]) => mockCreateArchive(...args),
  generateChecksum: (...args: unknown[]) => mockGenerateChecksum(...args),
  generateRegistryEntry: (...args: unknown[]) => mockGenerateRegistryEntry(...args),
}));

// Mock gh-submit
const mockSubmitToGitHub = jest.fn();
jest.mock('../utils/gh-submit.js', () => ({
  submitToGitHub: (...args: unknown[]) => mockSubmitToGitHub(...args),
}));

// Mock cloud-submit
const mockSubmitToCloud = jest.fn();
jest.mock('../utils/cloud-submit.js', () => ({
  submitToCloud: (...args: unknown[]) => mockSubmitToCloud(...args),
}));

// Mock fs
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    mkdirSync: jest.fn(),
    readFileSync: jest.fn().mockReturnValue('{"id":"test","name":"Test","description":"Test","version":"1.0.0","category":"development","assignableRoles":["developer"],"tags":["test"]}'),
  };
});

describe('publishCommand', () => {
  const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  const mockConsole = jest.spyOn(console, 'log').mockImplementation();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
    mockConsole.mockRestore();
  });

  it('should exit with error when no path is provided', async () => {
    await expect(publishCommand()).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should exit with error when validation fails', async () => {
    mockValidate.mockReturnValue({
      valid: false,
      errors: ['Missing required file: skill.json'],
      warnings: [],
    });

    await expect(publishCommand('/some/path')).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should print warnings during validation', async () => {
    mockValidate.mockReturnValue({
      valid: false,
      errors: ['Missing file'],
      warnings: ['No author'],
    });

    await expect(publishCommand('/some/path')).rejects.toThrow('process.exit');
    expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('No author'));
  });

  it('should stop at validation in dry-run mode', async () => {
    mockValidate.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });

    await publishCommand('/some/path', { dryRun: true });

    expect(mockCreateArchive).not.toHaveBeenCalled();
    expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
  });

  it('should create archive and print registry entry in normal mode', async () => {
    mockValidate.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mockCreateArchive.mockResolvedValue('/output/test-1.0.0.tar.gz');
    mockGenerateChecksum.mockReturnValue('sha256:abc123');
    mockGenerateRegistryEntry.mockReturnValue({
      id: 'test',
      type: 'skill',
      name: 'Test',
      version: '1.0.0',
    });

    await publishCommand('/some/path');

    expect(mockCreateArchive).toHaveBeenCalled();
    expect(mockGenerateChecksum).toHaveBeenCalledWith('/output/test-1.0.0.tar.gz');
    expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('Done'));
  });

  it('should call submitToGitHub when --submit flag is set', async () => {
    mockValidate.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mockCreateArchive.mockResolvedValue('/output/test-1.0.0.tar.gz');
    mockGenerateChecksum.mockReturnValue('sha256:abc123');
    mockGenerateRegistryEntry.mockReturnValue({
      id: 'test',
      type: 'skill',
      name: 'Test',
      version: '1.0.0',
    });
    mockSubmitToGitHub.mockResolvedValue({
      prUrl: 'https://github.com/stevehuang0115/crewly/pull/99',
      branch: 'skill/test',
      username: 'testuser',
    });

    await publishCommand('/some/path', { submit: true });

    expect(mockSubmitToGitHub).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'test' }),
    );
    expect(mockConsole).toHaveBeenCalledWith(
      expect.stringContaining('Pull request created successfully'),
    );
  });

  it('should call submitToCloud (and NOT gh) when --cloud flag is set', async () => {
    mockValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mockCreateArchive.mockResolvedValue('/output/test-1.0.0.tar.gz');
    mockGenerateChecksum.mockReturnValue('sha256:abc123');
    mockGenerateRegistryEntry.mockReturnValue({ id: 'test', type: 'skill' });
    mockSubmitToCloud.mockResolvedValue({
      prUrl: 'https://github.com/stevehuang0115/crewly/pull/100',
      branch: 'skill/test',
      updated: false,
    });

    await publishCommand('/some/path', { cloud: true });

    expect(mockSubmitToCloud).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'test' }),
    );
    expect(mockSubmitToGitHub).not.toHaveBeenCalled();
    expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('Submission PR opened'));
  });

  it('should exit when --cloud submission fails (e.g. not logged in)', async () => {
    mockValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mockCreateArchive.mockResolvedValue('/output/test-1.0.0.tar.gz');
    mockGenerateChecksum.mockReturnValue('sha256:abc123');
    mockGenerateRegistryEntry.mockReturnValue({ id: 'test', type: 'skill' });
    mockSubmitToCloud.mockRejectedValue(
      new Error('Not logged in to Crewly Cloud. Run `crewly cloud login` first.'),
    );

    await expect(publishCommand('/some/path', { cloud: true })).rejects.toThrow('process.exit');
    expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('Cloud submission failed'));
  });

  it('should show manual instructions when submit fails', async () => {
    mockValidate.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mockCreateArchive.mockResolvedValue('/output/test-1.0.0.tar.gz');
    mockGenerateChecksum.mockReturnValue('sha256:abc123');
    mockGenerateRegistryEntry.mockReturnValue({
      id: 'test',
      type: 'skill',
    });
    mockSubmitToGitHub.mockRejectedValue(new Error('gh not installed'));

    await expect(publishCommand('/some/path', { submit: true })).rejects.toThrow('process.exit');
    expect(mockConsole).toHaveBeenCalledWith(
      expect.stringContaining('Failed to submit'),
    );
    expect(mockConsole).toHaveBeenCalledWith(
      expect.stringContaining('submit manually'),
    );
  });
});
