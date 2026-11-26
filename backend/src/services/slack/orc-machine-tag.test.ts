import { applyOrcMachineTag, setOrcMachineSource, shortMachineName, startsWithOrcTag, tagOrcWithMachine } from './orc-machine-tag.js';

describe('orc-machine-tag', () => {
  it('shortens a device name', () => {
    expect(shortMachineName('mac-mini.lan')).toBe('mac-mini');
    expect(shortMachineName('MacBook-Pro-3.local')).toBe('MacBook-Pro-3');
    expect(shortMachineName('DESKTOP-RIG1SOO')).toBe('DESKTOP-RIG1SOO');
    expect(shortMachineName(' odd]name\n')).toBe('odd name');
    expect(shortMachineName(null)).toBe('');
  });

  it('names the machine when the account has several', () => {
    expect(tagOrcWithMachine('[Orc] 收到。', 'mac-mini.lan', 3)).toBe('[Orc · mac-mini] 收到。');
    expect(tagOrcWithMachine('[orc]\nline', 'iriss-air.lan', 2)).toBe('[orc · iriss-air]\nline');
  });

  it('leaves everything else alone', () => {
    expect(tagOrcWithMachine('[Orc] ok', 'mac-mini.lan', 1)).toBe('[Orc] ok');
    expect(tagOrcWithMachine('[Orc] ok', '', 3)).toBe('[Orc] ok');
    expect(tagOrcWithMachine('[Orc · mac-mini] ok', 'mac-mini.lan', 3)).toBe('[Orc · mac-mini] ok');
    expect(tagOrcWithMachine('[Orchid] ok', 'mac-mini.lan', 3)).toBe('[Orchid] ok');
    expect(tagOrcWithMachine('[Ella] ok', 'mac-mini.lan', 3)).toBe('[Ella] ok');
    expect(tagOrcWithMachine('see [Orc] above', 'mac-mini.lan', 3)).toBe('see [Orc] above');
  });

  it('recognises both forms of the tag', () => {
    expect(startsWithOrcTag('[Orc] hi')).toBe(true);
    expect(startsWithOrcTag('[Orc · mac-mini] hi')).toBe(true);
    expect(startsWithOrcTag('[Ella] hi')).toBe(false);
    expect(startsWithOrcTag('hello [Orc]')).toBe(false);
  });

  it('applies this machine\'s values, and nothing without a source', () => {
    setOrcMachineSource(null);
    expect(applyOrcMachineTag('[Orc] hi')).toBe('[Orc] hi');
    setOrcMachineSource(() => ({ deviceName: 'mac-mini.lan', machineCount: 4 }));
    expect(applyOrcMachineTag('[Orc] hi')).toBe('[Orc · mac-mini] hi');
    setOrcMachineSource(() => {
      throw new Error('boom');
    });
    expect(applyOrcMachineTag('[Orc] hi')).toBe('[Orc] hi');
    setOrcMachineSource(null);
  });
});
