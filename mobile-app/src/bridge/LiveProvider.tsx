import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatItem, Project, SessionStatus, TodoProgress } from "../data/types";
import { BridgeClient, type ConnState } from "./BridgeClient";
import { mapChatItem, mapProjects, statusPatch, type LivePatch } from "./live";
import { DEFAULT_BRIDGE_URL } from "./protocol";

export interface SessionLive {
  feed: ChatItem[];
  status: SessionStatus;
  activity?: string;
  compacting?: boolean;
  todos?: TodoProgress;
}

const EMPTY_LIVE: SessionLive = { feed: [], status: "idle" };

interface LiveValue {
  connState: ConnState;
  url: string;
  setUrl: (u: string) => void;
  /** dev shared token (CONDUIT_BRIDGE_TOKEN); empty for loopback/simulator */
  token: string;
  setToken: (t: string) => void;
  projects: Project[];
  /** live data for the currently-attached session */
  sessionLive: SessionLive;
  attach: (sessionId: string) => void;
  detach: () => void;
  /** send a prompt to a session (optimistically echoes the user bubble) */
  prompt: (sessionId: string, text: string) => void;
}

const Ctx = createContext<LiveValue | null>(null);

function applyPatch(prev: SessionLive, patch: LivePatch): SessionLive {
  return {
    feed: prev.feed,
    status: patch.status ?? prev.status,
    activity: patch.clearActivity ? undefined : patch.activity ?? prev.activity,
    compacting: patch.compacting ?? prev.compacting,
    todos: patch.todos ?? prev.todos,
  };
}

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [url, setUrl] = useState(DEFAULT_BRIDGE_URL);
  const [token, setToken] = useState("");
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionLive, setSessionLive] = useState<SessionLive>(EMPTY_LIVE);
  const clientRef = useRef<BridgeClient | null>(null);
  const attachedRef = useRef<string | null>(null);

  useEffect(() => {
    const client = new BridgeClient(url, {
      onState: (s) => {
        setConnState(s);
        if (s === "open") {
          client.list();
          // re-attach across reconnects (desktop is source of truth)
          if (attachedRef.current) {
            setSessionLive(EMPTY_LIVE);
            client.attach(attachedRef.current);
          }
        }
      },
      onMessage: (m) => {
        switch (m.type) {
          case "projects":
            setProjects(mapProjects(m.projects));
            break;
          case "history":
            setSessionLive((prev) => ({ ...prev, feed: m.items.map(mapChatItem) }));
            break;
          case "chat":
            setSessionLive((prev) => ({ ...prev, feed: [...prev.feed, mapChatItem(m.item)] }));
            break;
          case "status":
            setSessionLive((prev) => applyPatch(prev, statusPatch(m.event, m.body as never)));
            break;
          // size / output / error are not used by the chat UI
        }
      },
    }, token || undefined);
    clientRef.current = client;
    return () => client.close();
  }, [url, token]);

  const attach = useCallback((sessionId: string) => {
    attachedRef.current = sessionId;
    setSessionLive(EMPTY_LIVE);
    clientRef.current?.attach(sessionId);
  }, []);

  const detach = useCallback(() => {
    attachedRef.current = null;
  }, []);

  const prompt = useCallback((sessionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // No optimistic echo: claude logs the injected prompt to its transcript, which
    // the bridge tails back as a `chat` frame — avoids a duplicate user bubble.
    clientRef.current?.prompt(sessionId, trimmed);
  }, []);

  const value = useMemo<LiveValue>(
    () => ({ connState, url, setUrl, token, setToken, projects, sessionLive, attach, detach, prompt }),
    [connState, url, token, projects, sessionLive, attach, detach, prompt],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive must be used within a LiveProvider");
  return v;
}
