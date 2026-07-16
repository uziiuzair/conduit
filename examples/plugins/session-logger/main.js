export default class SessionLogger {
  async onload(conduit) {
    this.count = 0;
    conduit.hooks.on("lifecycle.stop", async (p) => {
      this.count++;
      await conduit.notify("Session Logger", `Agent stopped (session ${p.session}). Count: ${this.count}`);
    });
  }
  async onunload() { /* nothing to clean up */ }
}
