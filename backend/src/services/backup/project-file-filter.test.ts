/**
 * Tests for the project-file exclude matcher.
 */

import { createProjectFileFilter, globToRegExp } from './project-file-filter.js';
import { DEFAULT_PROJECT_FILE_EXCLUDES } from './backup.types.js';

describe('globToRegExp', () => {
  it('matches a single segment with * and ?', () => {
    expect(globToRegExp('*.log', false).test('app.log')).toBe(true);
    expect(globToRegExp('*.log', false).test('app.log.gz')).toBe(false);
    expect(globToRegExp('a?c', false).test('abc')).toBe(true);
  });

  it('matches whole paths with ** across segments', () => {
    expect(globToRegExp('build/**', true).test('build/a/b.js')).toBe(true);
    expect(globToRegExp('src/**/*.snap', true).test('src/x/y/z.snap')).toBe(true);
    expect(globToRegExp('src/**/*.snap', true).test('src/z.snap')).toBe(true);
    expect(globToRegExp('src/*.snap', true).test('src/x/z.snap')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(globToRegExp('a.b', false).test('axb')).toBe(false);
    expect(globToRegExp('(x)', false).test('(x)')).toBe(true);
  });
});

describe('createProjectFileFilter', () => {
  it('defaults exclude node_modules and .crewly at any depth but keep .git', () => {
    const f = createProjectFileFilter(DEFAULT_PROJECT_FILE_EXCLUDES);
    expect(f.isExcluded('node_modules')).toBe(true);
    expect(f.isExcluded('packages/app/node_modules/x/index.js')).toBe(true);
    expect(f.isExcluded('.crewly/wiki/a.md')).toBe(true);
    expect(f.isExcluded('.DS_Store')).toBe(true);
    expect(f.isExcluded('.git')).toBe(false);
    expect(f.isExcluded('.git/objects/pack/pack-1.pack')).toBe(false);
    expect(f.isExcluded('src/index.ts')).toBe(false);
  });

  it('segment patterns match names at any depth; path patterns match from the root', () => {
    const f = createProjectFileFilter(['*.log', 'dist/**', 'docs/*.pdf']);
    expect(f.isExcluded('a/b/c.log')).toBe(true);
    expect(f.isExcluded('dist/bundle.js')).toBe(true);
    expect(f.isExcluded('dist')).toBe(false); // `dist/**` matches contents; prune with `dist`
    expect(f.isExcluded('sub/dist/bundle.js')).toBe(false);
    expect(f.isExcluded('docs/a.pdf')).toBe(true);
    expect(f.isExcluded('docs/x/a.pdf')).toBe(false);
  });

  it('normalises leading ./ and trailing slashes, ignores blanks, and keeps patterns', () => {
    const f = createProjectFileFilter(['./tmp/', '', '  ']);
    expect(f.isExcluded('tmp')).toBe(true);
    expect(f.isExcluded('./tmp')).toBe(true);
    expect(f.patterns).toEqual(['./tmp/', '', '  ']);
  });

  it('excludes nothing with no patterns', () => {
    const f = createProjectFileFilter([]);
    expect(f.isExcluded('node_modules/x')).toBe(false);
    expect(f.isExcluded('')).toBe(false);
  });
});
