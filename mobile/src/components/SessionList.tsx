interface SessionListProps {
  sessions: string[];
  onPick: (id: string) => void;
}

export function SessionList({ sessions, onPick }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <p className="sessions__empty">
        No running sessions — open one in Conduit, then refresh.
      </p>
    );
  }

  return (
    <ul className="sessions">
      {sessions.map((id) => {
        const isShell = id.includes('::term');
        return (
          <li key={id}>
            <button
              className="sessions__row"
              type="button"
              onClick={() => onPick(id)}
            >
              <span className="sessions__id">{id}</span>
              {isShell && <span className="sessions__tag">(shell)</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
