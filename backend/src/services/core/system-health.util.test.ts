import { isUnderMemoryPressure, getMemoryStats, MEMORY_PRESSURE_SPAWN_THRESHOLD } from './system-health.util.js';
import * as os from 'os';

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024),
  freemem: jest.fn(() => 8 * 1024 * 1024 * 1024),
}));

const mockTotalmem = os.totalmem as jest.Mock;
const mockFreemem = os.freemem as jest.Mock;

describe('system-health.util', () => {
  it('should export MEMORY_PRESSURE_SPAWN_THRESHOLD as 90', () => {
    expect(MEMORY_PRESSURE_SPAWN_THRESHOLD).toBe(90);
  });

  it('should return false when memory usage < 90%', () => {
    mockFreemem.mockReturnValue(4 * 1024 * 1024 * 1024); // 75% used
    expect(isUnderMemoryPressure()).toBe(false);
  });

  it('should return true when memory usage >= 90%', () => {
    mockFreemem.mockReturnValue(800 * 1024 * 1024); // 95% used
    expect(isUnderMemoryPressure()).toBe(true);
  });

  it('should return correct memory stats', () => {
    mockFreemem.mockReturnValue(4 * 1024 * 1024 * 1024);
    const stats = getMemoryStats();
    expect(stats.totalMB).toBe(16384);
    expect(stats.freeMB).toBe(4096);
    expect(stats.usedPercent).toBe(75);
  });
});
