import { describe, it, expect } from 'vitest';
import { specialKey, ctrlChar } from './keys';

describe('specialKey', () => {
  it('maps special keys to terminal control byte sequences', () => {
    expect(specialKey('esc')).toBe('\x1b');
    expect(specialKey('tab')).toBe('\t');
    expect(specialKey('enter')).toBe('\r');
    expect(specialKey('up')).toBe('\x1b[A');
    expect(specialKey('down')).toBe('\x1b[B');
    expect(specialKey('right')).toBe('\x1b[C');
    expect(specialKey('left')).toBe('\x1b[D');
  });
});

describe('ctrlChar', () => {
  it('maps a letter to its control character (case-insensitive)', () => {
    expect(ctrlChar('c')).toBe('\x03');
    expect(ctrlChar('a')).toBe('\x01');
    expect(ctrlChar('C')).toBe('\x03');
  });
});
