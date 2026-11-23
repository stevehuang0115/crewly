import { formatIdList, sortIdsNaturally } from './id-list.js';

describe('id-list', () => {
  it('sorts ids the way a person reads them and drops duplicates', () => {
    expect(sortIdsNaturally(['CREW-10', 'CREW-2', 'CREW-1', 'CREW-2'])).toEqual(['CREW-1', 'CREW-2', 'CREW-10']);
  });

  it('names every id up to the cap and counts the rest past it', () => {
    expect(formatIdList([], 3)).toBe('');
    expect(formatIdList(['A-1', 'A-2', 'A-3'], 3)).toBe('A-1, A-2, A-3');
    expect(formatIdList(['A-1', 'A-2', 'A-3', 'A-4', 'A-5'], 3)).toBe('A-1, A-2, A-3, +2 more');
  });

  it('never names fewer than one id', () => {
    expect(formatIdList(['A-1', 'A-2'], 0)).toBe('A-1, +1 more');
  });
});
