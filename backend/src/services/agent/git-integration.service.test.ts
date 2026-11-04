import { execFileSync } from 'child_process';
import * as fsSync from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { GitIntegrationService } from './git-integration.service';

describe('GitIntegrationService', () => {
  let gitService: GitIntegrationService;
  let testProjectPath: string;

  beforeEach(() => {
    testProjectPath = '/test/project/path';
    gitService = new GitIntegrationService(testProjectPath);
  });

  afterEach(() => {
    (gitService as any).cleanup();
  });

  describe('Configuration', () => {
    test('should initialize with correct project path and interval', () => {
      expect(gitService).toBeDefined();
      expect((gitService as any).projectPath).toBe(testProjectPath);
      expect((gitService as any).defaultCommitConfig.intervalMinutes).toBe(30);
    });

    test('should use default interval when not specified', () => {
      const defaultService = new GitIntegrationService(testProjectPath);
      expect((defaultService as any).defaultCommitConfig.intervalMinutes).toBe(30);
      (defaultService as any).cleanup();
    });
  });

  describe('Timer Management', () => {
    test('should start and stop auto-commit timer', async () => {
      jest.useFakeTimers();
      const loggerSpy = jest.spyOn((gitService as any).logger, 'info').mockImplementation();

      await gitService.startAutoCommitTimer(1);
      expect(loggerSpy).toHaveBeenCalledWith('Started scheduled commits', {
        projectPath: testProjectPath,
        intervalMinutes: 1
      });

      gitService.stopScheduledCommits(testProjectPath);
      expect(loggerSpy).toHaveBeenCalledWith('Stopped scheduled commits', { projectPath: testProjectPath });

      jest.useRealTimers();
      loggerSpy.mockRestore();
    });

    test('should clear existing timer when starting new one', async () => {
      jest.useFakeTimers();
      const loggerSpy = jest.spyOn((gitService as any).logger, 'info').mockImplementation();

      await gitService.startAutoCommitTimer(1);
      await gitService.startAutoCommitTimer(2); // Should clear the first timer

      expect(loggerSpy).toHaveBeenCalledWith('Started scheduled commits', {
        projectPath: testProjectPath,
        intervalMinutes: 2
      });

      jest.useRealTimers();
      loggerSpy.mockRestore();
    });
  });

  describe('Cleanup', () => {
    test('should clean up resources on destroy', async () => {
      const loggerSpy = jest.spyOn((gitService as any).logger, 'info').mockImplementation();
      
      await gitService.startAutoCommitTimer(1);
      (gitService as any).cleanup();
      
      expect(loggerSpy).toHaveBeenCalledWith('Git integration cleanup complete');
      
      loggerSpy.mockRestore();
    });
  });
  describe('shell-free git calls in a real repository (CREW-967)', () => {
    let repo: string;
    let marker: string;
    let svc: GitIntegrationService;

    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

    beforeEach(() => {
      repo = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'git-int-'));
      marker = nodePath.join(repo, '..', `pwned-${nodePath.basename(repo)}`);
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 'T');
      git('config', 'commit.gpgsign', 'false');
      fsSync.writeFileSync(nodePath.join(repo, 'a.txt'), 'a');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      svc = new GitIntegrationService(repo);
    });

    afterEach(() => {
      (svc as any).cleanup();
      fsSync.rmSync(repo, { recursive: true, force: true });
      fsSync.rmSync(marker, { force: true });
    });

    it('commits a message full of shell syntax literally and runs nothing', async () => {
      const message = `msg $(touch ${marker}) \`touch ${marker}\` "q" 'r'; touch ${marker}`;
      fsSync.writeFileSync(nodePath.join(repo, 'b.txt'), 'b');

      await svc.commitChanges(repo, { message });

      expect(fsSync.existsSync(marker)).toBe(false);
      expect(git('log', '-1', '--format=%s')).toBe(message);
    });

    it('passes the author as one literal value', async () => {
      const author = `Eve $(touch ${marker}) <eve@example.com>`;
      fsSync.writeFileSync(nodePath.join(repo, 'c.txt'), 'c');

      await svc.commitChanges(repo, { message: 'by eve', author });

      expect(fsSync.existsSync(marker)).toBe(false);
      expect(git('log', '-1', '--format=%an <%ae>')).toBe('Eve $(touch ' + marker + ') <eve@example.com>');
    });

    it('creates a branch from a valid name and start point', async () => {
      await svc.createBranch('feature/x', 'main');
      expect(git('branch', '--show-current')).toBe('feature/x');
    });

    it('creates a branch whose name is shell syntax but a valid ref, as a literal name', async () => {
      const name = 'a$(touch${IFS}' + nodePath.basename(marker) + ')';
      await svc.createBranch(name);
      expect(git('branch', '--show-current')).toBe(name);
      expect(fsSync.existsSync(marker)).toBe(false);
    });

    it.each(['-x', '--detach', 'a b', 'x$(touch /tmp/p)', 'a;b c'])('refuses branch name %j before running git', async (bad) => {
      await expect(svc.createBranch(bad)).rejects.toThrow('Invalid branch name');
      expect(git('branch', '--show-current')).toBe('main');
    });

    it('refuses an unsafe start point before running git', async () => {
      await expect(svc.createBranch('ok', '--orphan')).rejects.toThrow('Invalid start point');
      expect(git('branch', '--list', 'ok')).toBe('');
    });
  });
});
