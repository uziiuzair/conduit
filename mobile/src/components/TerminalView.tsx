import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { BridgeClient } from '../bridge';
import { KeyBar } from './KeyBar';

interface TerminalViewProps {
  bridge: BridgeClient;
  sessionId: string;
}

export function TerminalView({ bridge, sessionId }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0d0f14', foreground: '#e6e6e6' },
    });
    // FitAddon is loaded so xterm sizes its viewport to the host element, but we
    // never fit-and-push a resize: the bridge is desktop-authoritative on size.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    bridge.onOutput = (bytes) => term.write(bytes);
    // ADOPT the desktop's size; never send one back.
    bridge.onSize = (cols, rows) => term.resize(cols, rows);
    const dataSub = term.onData((d) => bridge.sendInput(sessionId, d));

    bridge.attach(sessionId);
    term.focus();

    return () => {
      dataSub.dispose();
      bridge.onOutput = () => {};
      bridge.onSize = () => {};
      term.dispose();
      termRef.current = null;
    };
  }, [bridge, sessionId]);

  return (
    <div className="terminal">
      <div className="terminal__host" ref={hostRef} />
      <KeyBar onSeq={(seq) => bridge.sendInput(sessionId, seq)} />
    </div>
  );
}
