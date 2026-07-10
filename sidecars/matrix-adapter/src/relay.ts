// The relay: Matrix rooms ⇄ Conduit sessions. Each room binds to at most one
// session (persisted); owner messages in a bound room become PTY prompts; the
// session's transcript tail streams back as chat. Owner-only by allowlist —
// room membership is NOT authority over the terminal.

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { discoverBridgeUrl, fetchProjects, SessionLink } from "./bridge.js";
import { loadSettings, saveSettings, type Settings } from "./config.js";
import {
  controlKeyBytes,
  CONTROL_KEY_NAMES,
  INTERRUPT_KEY,
  promptToInsert,
  SUBMIT_KEY,
  typingForStatus,
  type ChatItem,
} from "./protocol.js";
import {
  HELP_TEXT,
  parseCommand,
  PromptEcho,
  renderChatBatch,
  renderSessionList,
  resolveUseTarget,
  indexSessions,
  type IndexedSession,
} from "./render.js";
import { sendMessage } from "./matrix.js";

const TYPING_REFRESH_MS = 25_000;
/** Gap between inserting the prompt text and sending Enter, so the TUI renders the
 *  text as field content before it sees the submit keystroke. */
const SUBMIT_DELAY_MS = 90;

interface RoomState {
  link: SessionLink;
  echo: PromptEcho;
  typing: boolean;
  typingTimer: NodeJS.Timeout | null;
}

export class Relay {
  private settings: Settings;
  private rooms = new Map<string, RoomState>();
  private lastListing: IndexedSession[] = [];
  private bridgeUrl: string | null = null;

  constructor(
    private client: MatrixClient,
    private ownUserId: string,
  ) {
    this.settings = loadSettings();
  }

  /** Wire Matrix events and re-attach persisted bindings. */
  async start(): Promise<void> {
    this.client.on("room.message", (roomId: string, event: any) => {
      void this.onMessage(roomId, event).catch((e) =>
        console.error(`relay: message handler failed: ${e}`),
      );
    });
    this.bridgeUrl = await discoverBridgeUrl();
    if (!this.bridgeUrl) {
      console.error("relay: Conduit bridge not found (is the desktop app running?)");
    }
    for (const [roomId, sessionId] of Object.entries(this.settings.rooms)) {
      this.bind(roomId, sessionId, { announce: false });
    }
  }

  private isOwner(sender: string): boolean {
    return this.settings.owners.includes(sender);
  }

  private async notice(roomId: string, body: string): Promise<void> {
    await sendMessage(this.client, roomId, "m.notice", body).catch((e) =>
      console.error(`relay: notice failed in ${roomId}: ${e}`),
    );
  }

  private async onMessage(roomId: string, event: any): Promise<void> {
    const sender: string = event?.sender ?? "";
    const body: string | undefined = event?.content?.body;
    const msgtype: string | undefined = event?.content?.msgtype;
    if (sender === this.ownUserId || typeof body !== "string") return;
    if (msgtype !== "m.text") return; // notices/media aren't prompts
    if (!this.isOwner(sender)) return; // default-closed
    if (/^\/bot\b/i.test(body.trim())) return; // BadgerClaw's namespace

    const command = parseCommand(body);
    if (command) {
      await this.handleCommand(roomId, command);
      return;
    }

    const state = this.rooms.get(roomId);
    if (!state) {
      await this.notice(roomId, "No session bound here — `/conduit list` then `/conduit use <n>`.");
      return;
    }
    state.echo.record(body.trim());
    // Two writes: insert the text, then a beat later send Enter as its own
    // keystroke. Sending them together makes Claude Code's TUI treat the whole
    // thing as a paste and NOT submit (the "typed but not executed" bug).
    if (!state.link.send(promptToInsert(body))) {
      await this.notice(roomId, "⚠️ Bridge link is down — is Conduit running on the desktop?");
      return;
    }
    setTimeout(() => state.link.send(SUBMIT_KEY), SUBMIT_DELAY_MS);
  }

  private async handleCommand(
    roomId: string,
    command: NonNullable<ReturnType<typeof parseCommand>>,
  ): Promise<void> {
    switch (command.cmd) {
      case "help":
        await this.notice(roomId, HELP_TEXT);
        return;
      case "list": {
        const projects = await this.listProjects();
        if (projects === null) {
          await this.notice(roomId, "⚠️ Conduit bridge unreachable — is the desktop app running?");
          return;
        }
        this.lastListing = indexSessions(projects);
        await this.notice(roomId, renderSessionList(projects));
        return;
      }
      case "use": {
        const sessionId = resolveUseTarget(command.target, this.lastListing);
        if (!sessionId) {
          await this.notice(roomId, "Unknown target — run `/conduit list` and use an index or session id.");
          return;
        }
        this.bind(roomId, sessionId, { announce: true });
        return;
      }
      case "detach": {
        this.unbind(roomId);
        await this.notice(roomId, "Detached.");
        return;
      }
      case "status": {
        const state = this.rooms.get(roomId);
        if (!state) {
          await this.notice(roomId, "No session bound to this room.");
        } else {
          await this.notice(
            roomId,
            `Bound to session ${state.link.sessionId} — bridge link ${state.link.isUp ? "up" : "DOWN (retrying)"}.`,
          );
        }
        return;
      }
      case "stop": {
        const state = this.rooms.get(roomId);
        if (!state) {
          await this.notice(roomId, "No session bound here.");
        } else if (state.link.send(INTERRUPT_KEY)) {
          await this.notice(roomId, "⎋ sent interrupt (Ctrl-C).");
        } else {
          await this.notice(roomId, "⚠️ Bridge link is down.");
        }
        return;
      }
      case "key": {
        const state = this.rooms.get(roomId);
        if (!state) {
          await this.notice(roomId, "No session bound here.");
          return;
        }
        const bytes = controlKeyBytes(command.key);
        if (bytes === null) {
          await this.notice(roomId, `Unknown key "${command.key}". Try: ${CONTROL_KEY_NAMES}`);
          return;
        }
        if (!state.link.send(bytes)) await this.notice(roomId, "⚠️ Bridge link is down.");
        return;
      }
      case "send": {
        const state = this.rooms.get(roomId);
        if (!state) {
          await this.notice(roomId, "No session bound here.");
          return;
        }
        // Insert text WITHOUT the submitting Enter (edit on the desktop first).
        if (!state.link.send(promptToInsert(command.text))) {
          await this.notice(roomId, "⚠️ Bridge link is down.");
        }
        return;
      }
    }
  }

  private async listProjects() {
    this.bridgeUrl ??= await discoverBridgeUrl();
    if (!this.bridgeUrl) return null;
    try {
      return await fetchProjects(this.bridgeUrl);
    } catch {
      // Conduit may have restarted on a different port in the range.
      this.bridgeUrl = await discoverBridgeUrl();
      if (!this.bridgeUrl) return null;
      try {
        return await fetchProjects(this.bridgeUrl);
      } catch {
        return null;
      }
    }
  }

  private bind(roomId: string, sessionId: string, opts: { announce: boolean }): void {
    this.unbind(roomId);
    if (!this.bridgeUrl) {
      void this.notice(roomId, "⚠️ Conduit bridge unreachable — binding saved, will attach when it's back.");
    }
    const echo = new PromptEcho();
    const link = new SessionLink(this.bridgeUrl ?? "ws://127.0.0.1:8455", sessionId, {
      onUp: () => {
        if (opts.announce) {
          void this.notice(roomId, `Attached — new activity streams here. Type to prompt the session.`);
          opts.announce = false; // once per explicit bind, not per reconnect
        }
      },
      onHistoryCount: (n) => {
        if (n > 0 && opts.announce) {
          void this.notice(roomId, `(${n} earlier transcript items not replayed)`);
        }
      },
      onChat: (items) => void this.onChat(roomId, items),
      onStatus: (event, body) => void this.onStatus(roomId, event, body),
      onDown: (reason) => {
        void this.setTyping(roomId, false);
        void this.notice(roomId, `⚠️ Session link down (${reason}) — retrying in the background.`);
      },
    });
    this.rooms.set(roomId, { link, echo, typing: false, typingTimer: null });
    this.settings.rooms[roomId] = sessionId;
    saveSettings(this.settings);
  }

  private unbind(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (state) {
      state.link.close();
      if (state.typingTimer) clearTimeout(state.typingTimer);
      void this.setTyping(roomId, false);
      this.rooms.delete(roomId);
    }
    if (this.settings.rooms[roomId]) {
      delete this.settings.rooms[roomId];
      saveSettings(this.settings);
    }
  }

  private async onChat(roomId: string, items: ChatItem[]): Promise<void> {
    const state = this.rooms.get(roomId);
    if (!state) return;
    const messages = renderChatBatch(items, (text) => state.echo.matches(text.trim()));
    for (const m of messages) {
      await sendMessage(this.client, roomId, m.msgtype, m.body).catch((e) =>
        console.error(`relay: send failed in ${roomId}: ${e}`),
      );
    }
  }

  private async onStatus(roomId: string, event: string, body: unknown): Promise<void> {
    const typing = typingForStatus(event);
    if (typing !== null) await this.setTyping(roomId, typing);
    if (event === "notification") {
      const message =
        (body as { message?: string } | null)?.message ?? "needs your input";
      await sendMessage(this.client, roomId, "m.text", `⚠️ ${message}`).catch(() => {});
    }
  }

  /** Typing indicator with keep-alive refresh while the agent runs (an "on" while
   *  already on falls through deliberately — it re-sends before the TTL lapses). */
  private async setTyping(roomId: string, on: boolean): Promise<void> {
    const state = this.rooms.get(roomId);
    if (!state) return;
    if (!on && !state.typing) return;
    state.typing = on;
    if (state.typingTimer) {
      clearTimeout(state.typingTimer);
      state.typingTimer = null;
    }
    await this.client.setTyping(roomId, on, TYPING_REFRESH_MS + 5_000).catch(() => {});
    if (on) {
      state.typingTimer = setTimeout(() => {
        state.typingTimer = null;
        if (state.typing) void this.setTyping(roomId, true);
      }, TYPING_REFRESH_MS);
    }
  }
}
