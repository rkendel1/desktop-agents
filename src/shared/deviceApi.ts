/** Desktop host capabilities, separate from account data and chat commands.
 * Web/mobile hosts must supply their own UI affordances instead of treating
 * local paths, windows or clipboard access as cloud data operations. */
export interface DesktopDeviceApi {
  resizeDialog: (name: string, width: number, height: number) => Promise<boolean>
  reportDiagnostic: (event: string, detail: string) => void
  openDiagnosticLogs: () => Promise<void>
  copyText: (text: string) => Promise<void>
  copyAttachment: (attachmentId: string) => Promise<void>
  platform: string
  microphonePermissionOwner: 'Foundry' | 'Electron'
  windowAction: (action: 'close' | 'minimize' | 'fullscreen') => void
  requestMicrophoneAccess: () => Promise<'granted' | 'denied' | 'unsupported'>
  openMicrophoneSettings: () => Promise<void>
  openLocalFile: (path: string, conversationId?: string) => Promise<void>
  openConversationWindow: (conversationId: string) => Promise<void>
}
