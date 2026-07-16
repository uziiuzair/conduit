export interface ConduitPluginApi {
  hooks: { on(event: string, fn: (payload: unknown) => void | Promise<void>): void };
  commands: {
    register(id: string, fn: () => void | Promise<void>): Promise<void>;
    unregister(id: string): Promise<void>;
  };
  notify(title: string, body?: string): Promise<void>;
  clipboard: { write(text: string): Promise<void> };
  net: { fetch(url: string, init?: RequestInit): Promise<{ status: number; body: string }> };
}

export interface ConduitPlugin {
  onload(conduit: ConduitPluginApi): void | Promise<void>;
  onunload?(): void | Promise<void>;
}
