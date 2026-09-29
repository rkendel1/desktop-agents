interface NotificationWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, payload?: unknown): void
  }
}

/** A closing renderer must never fail the task whose progress it displays. */
export function notifyWindows(windows: NotificationWindow[], channel: string, payload?: unknown): void {
  for (const window of windows) {
    try {
      if (window.isDestroyed()) continue
      const contents = window.webContents
      if (contents.isDestroyed()) continue
      contents.send(channel, payload)
    } catch (error) {
      // Native objects can be destroyed between the checks and send(). Keep
      // notifying the other windows; UI delivery is not task execution.
      console.warn(`[foundry] Could not notify renderer (${channel}):`, error instanceof Error ? error.message : error)
    }
  }
}
