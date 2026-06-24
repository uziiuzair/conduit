import { useRef, useState } from 'react';
import { BridgeClient } from './bridge';
import { SessionList } from './components/SessionList';
import { TerminalView } from './components/TerminalView';

type Screen = 'connect' | 'list' | 'terminal';

export function App() {
  const [screen, setScreen] = useState<Screen>('connect');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('8455');
  const [sessions, setSessions] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Hold the live client across screens; the socket stays open the whole session.
  const bridgeRef = useRef<BridgeClient | null>(null);

  function connect() {
    setError(null);
    setConnecting(true);

    // Tear down any prior client before reconnecting.
    bridgeRef.current?.close();

    const bridge = new BridgeClient(`ws://${host}:${port}`);
    bridgeRef.current = bridge;

    bridge.onOpen = () => {
      setConnecting(false);
      bridge.list();
      setScreen('list');
    };
    bridge.onSessions = (ids) => setSessions(ids);
    bridge.onError = (msg) => {
      setConnecting(false);
      setError(msg);
    };
    bridge.onClose = () => {
      setConnecting(false);
      setSessionId(null);
      setScreen('connect');
    };

    bridge.connect();
  }

  function refresh() {
    bridgeRef.current?.list();
  }

  function pick(id: string) {
    setSessionId(id);
    setScreen('terminal');
  }

  function back() {
    setSessionId(null);
    setScreen('list');
    bridgeRef.current?.list();
  }

  if (screen === 'connect') {
    return (
      <main className="screen screen--connect">
        <h1 className="brand">Conduit</h1>
        <p className="subtitle">Connect to your desktop bridge</p>
        <form
          className="connect-form"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <label className="field">
            <span>Host</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>
          <label className="field">
            <span>Port</span>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button className="btn btn--primary" type="submit" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  if (screen === 'list') {
    return (
      <main className="screen screen--list">
        <header className="topbar">
          <span className="topbar__title">Sessions</span>
          <button className="btn btn--ghost" type="button" onClick={refresh}>
            Refresh
          </button>
        </header>
        <SessionList sessions={sessions} onPick={pick} />
      </main>
    );
  }

  // terminal
  return (
    <main className="screen screen--terminal">
      <header className="topbar">
        <button className="btn btn--ghost" type="button" onClick={back}>
          ‹ Back
        </button>
        <span className="topbar__title topbar__title--mono">{sessionId}</span>
      </header>
      {bridgeRef.current && sessionId && (
        <TerminalView bridge={bridgeRef.current} sessionId={sessionId} />
      )}
    </main>
  );
}
