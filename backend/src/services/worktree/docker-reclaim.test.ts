import { containerBuilders, olderRegistryTags, reclaimDocker } from './docker-reclaim.js';

describe('olderRegistryTags', () => {
  it('keeps the newest tag of each registry repo and never touches local images', () => {
    const listing = [
      'dr.careerengine.dev/web-visa 1.3.159',
      'dr.careerengine.dev/web-visa 1.3.158',
      'dr.careerengine.dev/crewly-apps 0.5.8',
      'dr.careerengine.dev/web-visa 1.3.157',
      'moby/buildkit buildx-stable-1',
      'my-local-image latest',
      '<none> <none>',
    ].join('\n');
    expect(olderRegistryTags(listing)).toEqual(['dr.careerengine.dev/web-visa:1.3.158', 'dr.careerengine.dev/web-visa:1.3.157']);
  });
});

describe('containerBuilders', () => {
  it('lists docker-container builders only', () => {
    const listing = [
      'NAME/NODE           DRIVER/ENDPOINT     STATUS    BUILDKIT',
      'steamfun            docker-container',
      ' \\_ steamfun0        \\_ desktop-linux   running   v0.33.1',
      'desktop-linux*      docker',
      ' \\_ desktop-linux    \\_ desktop-linux   running   v0.23.2',
    ].join('\n');
    expect(containerBuilders(listing)).toEqual(['steamfun']);
  });
});

describe('reclaimDocker', () => {
  it('does nothing when docker is not reachable', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('no daemon'));
    expect(await reclaimDocker(exec)).toEqual({ ran: false, removedImages: [] });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('removes older tags, prunes caches, never volumes or containers', async () => {
    const exec = jest.fn(async (args: string[]) => {
      if (args[0] === 'images') return 'dr.x.dev/a 2\ndr.x.dev/a 1\n';
      if (args[0] === 'buildx' && args[1] === 'ls') return 'b1 docker-container\n';
      return '';
    });
    const r = await reclaimDocker(exec);
    expect(r).toEqual({ ran: true, removedImages: ['dr.x.dev/a:1'] });
    const calls = exec.mock.calls.map((c) => c[0].join(' '));
    expect(calls).toContain('rmi dr.x.dev/a:1');
    expect(calls).toContain('builder prune -f --keep-storage 3gb');
    expect(calls).toContain('buildx prune --builder b1 -f --keep-storage 3gb');
    expect(calls.some((c) => /volume|container rm|system prune/.test(c))).toBe(false);
  });
});
