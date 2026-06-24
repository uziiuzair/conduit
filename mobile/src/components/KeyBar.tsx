import { specialKey, ctrlChar } from '../keys';

interface KeyBarProps {
  /** Called with the raw control sequence for the pressed key. */
  onSeq: (seq: string) => void;
}

interface KeyDef {
  label: string;
  seq: string;
}

const KEYS: KeyDef[] = [
  { label: 'Esc', seq: specialKey('esc') },
  { label: 'Tab', seq: specialKey('tab') },
  { label: 'Ctrl-C', seq: ctrlChar('c') },
  { label: '←', seq: specialKey('left') },
  { label: '↑', seq: specialKey('up') },
  { label: '↓', seq: specialKey('down') },
  { label: '→', seq: specialKey('right') },
  { label: 'Enter', seq: specialKey('enter') },
];

export function KeyBar({ onSeq }: KeyBarProps) {
  return (
    <div className="keybar">
      {KEYS.map((k) => (
        <button
          key={k.label}
          className="keybar__key"
          type="button"
          // Use onPointerDown so the key fires before the terminal can steal focus,
          // and preventDefault to avoid the soft keyboard / scroll fighting the tap.
          onPointerDown={(e) => {
            e.preventDefault();
            onSeq(k.seq);
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
