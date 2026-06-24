export type SpecialKey = 'esc' | 'tab' | 'enter' | 'up' | 'down' | 'left' | 'right';

const SPECIAL: Record<SpecialKey, string> = {
  esc: '\x1b',
  tab: '\t',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
};

export function specialKey(k: SpecialKey): string {
  return SPECIAL[k];
}

/** Control character for ctrl+<letter>, e.g. ctrl+c → '\x03'. */
export function ctrlChar(letter: string): string {
  return String.fromCharCode(letter.toLowerCase().charCodeAt(0) & 0x1f);
}
