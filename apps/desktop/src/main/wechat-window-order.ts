/** Tracks the last user-visible order across the focus change caused by clicking the Dock. */
export class WechatWindowOrder {
  private foreground = false;
  private blurredAt: number | null = null;
  private press: { foreground: boolean; at: number } | null = null;
  private commandAt = 0;

  focus(at = Date.now()): void {
    if (at <= this.commandAt) return;
    this.foreground = true;
    this.blurredAt = null;
  }

  blur(at = Date.now()): void {
    if (at <= this.commandAt || !this.foreground) return;
    this.blurredAt = at;
  }

  minimize(at = Date.now()): void {
    if (at <= this.commandAt) return;
    this.setForeground(false, at);
  }

  setForeground(foreground: boolean, at = Date.now()): void {
    this.foreground = foreground;
    this.blurredAt = null;
    this.press = null;
    this.commandAt = at;
  }

  beginDockPress(at = Date.now()): void {
    // Windows activates the launcher before its pointerdown arrives. Preserve the
    // preceding window state across that brief focus transition.
    this.press = { foreground: this.isForeground(at), at };
  }

  cancelDockPress(): void { this.press = null; }

  toggle(usePress: boolean, at = Date.now()): boolean {
    const current = usePress && this.press && at - this.press.at < 30000
      ? this.press.foreground
      : this.isForeground(at);
    this.setForeground(!current, at);
    return !current;
  }

  private isForeground(at: number): boolean {
    return this.foreground && (this.blurredAt === null || at - this.blurredAt <= 700);
  }
}
