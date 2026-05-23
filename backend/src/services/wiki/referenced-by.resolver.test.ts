/**
 * Tests for ReferencedByResolver.
 *
 * Strategy: build a temp directory mimicking the crewly repo layout
 * (config/skills/*, backend/src/services/*), run the resolver against it,
 * verify hits/misses + caching behavior.
 *
 * @module services/wiki/referenced-by.resolver.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { ReferencedByResolver } from './referenced-by.resolver.js';
import { ReferencedBySymbol } from './wiki.types.js';

describe('ReferencedByResolver', () => {
  let tmpRoot: string;
  let resolver: ReferencedByResolver;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-resolver-test-'));
    // Mimic the Crewly layout the resolver expects.
    await fs.mkdir(path.join(tmpRoot, 'config/skills/agent/core/get-sops'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'config/skills/agent/core/get-sops/execute.sh'), '#!/bin/bash\n');

    await fs.mkdir(path.join(tmpRoot, 'config/skills/orchestrator/wiki-ingest'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'config/skills/orchestrator/wiki-ingest/execute.sh'),
      '#!/bin/bash\n',
    );

    await fs.mkdir(path.join(tmpRoot, 'backend/src/services/sop'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'backend/src/services/sop/sop.service.ts'),
      'export class SopService {}',
    );

    resolver = new ReferencedByResolver(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('rejects relative paths', () => {
      expect(() => new ReferencedByResolver('relative/path')).toThrow(/must be absolute/);
    });
  });

  describe('resolve(skill:*)', () => {
    it('resolves an agent-core skill', async () => {
      const result = await resolver.resolve('skill:get-sops');
      expect(result.exists).toBe(true);
      expect(result.absolutePath).toBe(
        path.join(tmpRoot, 'config/skills/agent/core/get-sops/execute.sh'),
      );
      expect(result.symbol).toBe('skill:get-sops');
    });

    it('resolves an orchestrator-namespaced skill', async () => {
      const result = await resolver.resolve('skill:wiki-ingest');
      expect(result.exists).toBe(true);
      expect(result.absolutePath).toBe(
        path.join(tmpRoot, 'config/skills/orchestrator/wiki-ingest/execute.sh'),
      );
    });

    it('returns exists=false with canonical fallback path when skill is missing', async () => {
      const result = await resolver.resolve('skill:does-not-exist');
      expect(result.exists).toBe(false);
      expect(result.absolutePath).toContain('config/skills/agent/core/does-not-exist/execute.sh');
    });
  });

  describe('resolve(service:*)', () => {
    it('resolves a backend service file by basename', async () => {
      const result = await resolver.resolve('service:sop.service');
      expect(result.exists).toBe(true);
      expect(result.absolutePath).toBe(
        path.join(tmpRoot, 'backend/src/services/sop/sop.service.ts'),
      );
    });

    it('returns exists=false with canonical fallback path when service is missing', async () => {
      const result = await resolver.resolve('service:phantom.service');
      expect(result.exists).toBe(false);
      // Convention: `service:phantom.service` → dir `phantom/`, file `phantom.service.ts`.
      expect(result.absolutePath).toContain('backend/src/services/phantom/phantom.service.ts');
    });

    it('falls back without .service suffix when symbol omits it', async () => {
      const result = await resolver.resolve('service:bare' as ReferencedBySymbol);
      expect(result.exists).toBe(false);
      // Without `.service` suffix in the symbol, use the full name as dir and file basename.
      expect(result.absolutePath).toContain('backend/src/services/bare/bare.ts');
    });

    it('skips node_modules + dist when scanning', async () => {
      // Drop a decoy that would match if scanning weren't bounded.
      await fs.mkdir(path.join(tmpRoot, 'backend/src/services/node_modules/decoy'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tmpRoot, 'backend/src/services/node_modules/decoy/sop.service.ts'),
        '// decoy',
      );
      const result = await resolver.resolve('service:sop.service');
      expect(result.absolutePath).not.toContain('node_modules');
      expect(result.absolutePath).toBe(
        path.join(tmpRoot, 'backend/src/services/sop/sop.service.ts'),
      );
    });
  });

  describe('parseSymbol error paths', () => {
    it('throws on missing colon', async () => {
      await expect(resolver.resolve('skillget-sops' as ReferencedBySymbol)).rejects.toThrow(
        /malformed symbol/,
      );
    });

    it('throws on unknown kind', async () => {
      await expect(resolver.resolve('config:foo' as ReferencedBySymbol)).rejects.toThrow(
        /unknown kind/,
      );
    });

    it('throws on empty name', async () => {
      await expect(resolver.resolve('skill:' as ReferencedBySymbol)).rejects.toThrow(/empty name/);
    });
  });

  describe('caching', () => {
    it('returns the same object on repeated resolves', async () => {
      const a = await resolver.resolve('skill:get-sops');
      const b = await resolver.resolve('skill:get-sops');
      expect(a).toBe(b);
    });

    it('clearCache() forces re-resolution', async () => {
      const a = await resolver.resolve('skill:get-sops');
      resolver.clearCache();
      const b = await resolver.resolve('skill:get-sops');
      // Same shape, different object identity.
      expect(a).not.toBe(b);
      expect(a.absolutePath).toBe(b.absolutePath);
    });
  });

  describe('resolveAll', () => {
    it('resolves a batch in parallel', async () => {
      const results = await resolver.resolveAll([
        'skill:get-sops',
        'skill:wiki-ingest',
        'service:sop.service',
      ]);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.exists)).toBe(true);
    });
  });
});
