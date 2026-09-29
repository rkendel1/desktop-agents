import type { SelectedMention } from '../shared/bot/mentions'
import type { ProjectionDelta } from '../shared/projection'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  CodeArtifactInput,
  CreateAgentInput,
  CustomLocalAgentInput,
  EmailConnectorInput,
  MessageImageInput,
  MessageFileInput,
  CreateGroupInput,
  CreateRoutineInput,
  UpdateAgentInput,
  UpdateConversationInput,
  UpdateProfileInput,
  UpdateState,
  DouchatApi
} from '../shared/types'

const api: DouchatApi = {
  getGroupMemory: conversationId => ipcRenderer.invoke('douchat:group-memory', conversationId),
  saveGroupMemory: (document, conversationId) => ipcRenderer.invoke('douchat:save-group-memory', document, conversationId),
  getUserMemory: agentId => ipcRenderer.invoke('douchat:user-memory', agentId),
  saveUserMemory: (document, agentId) => ipcRenderer.invoke('douchat:save-user-memory', document, agentId),
  listIMChannels: agent => ipcRenderer.invoke('douchat:im-list', agent),
  connectIMChannel: (agent, input) => ipcRenderer.invoke('douchat:im-connect', agent, input),
  disconnectIMChannel: (agent, provider) => ipcRenderer.invoke('douchat:im-disconnect', agent, provider),
  startIMLogin: agent => ipcRenderer.invoke('douchat:im-login', agent),
  cancelIMLogin: (agent, session) => ipcRenderer.invoke('douchat:im-cancel-login', agent, session),
  pollIMLogin: (agent, session) => ipcRenderer.invoke('douchat:im-status', agent, session),
  resizeDialog: (name, width, height) => ipcRenderer.invoke('douchat:resize-dialog', name, width, height),
  reportDiagnostic: (event, detail) => ipcRenderer.send('douchat:diagnostic', event, detail),
  openDiagnosticLogs: () => ipcRenderer.invoke('douchat:open-diagnostic-logs'),
  copyText: (text) => ipcRenderer.invoke('douchat:copy-text', text),
  copyAttachment: (id) => ipcRenderer.invoke('douchat:copy-attachment', id),
  platform: process.platform,
  microphonePermissionOwner: 'Douchat',
  windowAction: (action) => ipcRenderer.send('douchat:window-action', action),
  requestMicrophoneAccess: () => ipcRenderer.invoke('douchat:request-microphone-access'),
  openMicrophoneSettings: () => ipcRenderer.invoke('douchat:open-microphone-settings'),
  setInterfaceLanguage: (language: string) => ipcRenderer.invoke('douchat:set-interface-language', language),
  updateProfile: (input: UpdateProfileInput) => ipcRenderer.invoke('douchat:update-profile', input),
  completeOnboarding: () => ipcRenderer.invoke('douchat:complete-onboarding'),
  resolveAttention: (id: string) => ipcRenderer.invoke('douchat:resolve-attention', id),
  getUpdateState: () => ipcRenderer.invoke('douchat:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('douchat:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('douchat:install-update'),
  maintainLocalAgent: (id: string) => ipcRenderer.invoke('douchat:maintain-local-agent', id),
  listLocalAgentModels: (agentId: string) => ipcRenderer.invoke('douchat:list-local-agent-models', agentId),
  detectLocalAgents: () => ipcRenderer.invoke('douchat:detect-local-agents'),
  openLocalAgentTerminal: (id: 'claude') => ipcRenderer.invoke('douchat:open-local-agent-terminal', id),
  addCustomLocalAgent: (input: CustomLocalAgentInput) => ipcRenderer.invoke('douchat:add-custom-local-agent', input),
  updateLocalAgent: (id: string, input: CustomLocalAgentInput) => ipcRenderer.invoke('douchat:update-local-agent', id, input),
  testLocalAgent: (id: string | undefined, input: CustomLocalAgentInput) => ipcRenderer.invoke('douchat:test-local-agent', id, input),
  cancelLocalAgentTest: () => ipcRenderer.invoke('douchat:cancel-local-agent-test'),
  removeCustomLocalAgent: (id: string) => ipcRenderer.invoke('douchat:remove-custom-local-agent', id),
  searchMessages: (conversationId, query) => ipcRenderer.invoke('douchat:search-messages', conversationId, query),
  getMessagePage: (conversationId, topicId, before) => ipcRenderer.invoke('douchat:message-page', conversationId, topicId, before),
  getAttachmentData: (attachmentId) => ipcRenderer.invoke('douchat:attachment-data', attachmentId),
  openLocalFile: (path, conversationId) => ipcRenderer.invoke('douchat:open-local-file', path, conversationId),
  getSnapshot: () => ipcRenderer.invoke('douchat:get-snapshot'),
  authorizeTokenDance: () => ipcRenderer.invoke('douchat:authorize-tokendance'),
  cancelTokenDanceAuthorization: () => ipcRenderer.invoke('douchat:cancel-tokendance'),
  getCustomModels: () => ipcRenderer.invoke('douchat:custom-models'),
  detectOllama: () => ipcRenderer.invoke('douchat:detect-ollama'),
  getDecisionSettings: () => ipcRenderer.invoke('douchat:decision-settings'),
  saveDecisionSettings: (settings) => ipcRenderer.invoke('douchat:save-decision-settings', settings),
  testDecisionSettings: (settings) => ipcRenderer.invoke('douchat:test-decision-settings', settings),
  saveCustomModels: (providers, defaultModel) => ipcRenderer.invoke('douchat:save-custom-models', providers, defaultModel),
  testCustomModel: (input) => ipcRenderer.invoke('douchat:test-custom-model', input),
  createAgent: (input: CreateAgentInput) => ipcRenderer.invoke('douchat:create-agent', input),
  resolveAgentPermission: (id, allow) => ipcRenderer.invoke('douchat:resolve-agent-permission', id, allow),
  exportAgentArchive: id => ipcRenderer.invoke('douchat:export-agent-archive', id),
  parseAgentArchive: (data, root) => ipcRenderer.invoke('douchat:parse-agent-archive', data, root),
  parseSkillArchive: data => ipcRenderer.invoke('douchat:parse-skill-archive', data),
  updateAgent: (agentId: string, input: UpdateAgentInput) => ipcRenderer.invoke('douchat:update-agent', agentId, input),
  deleteAgent: (agentId: string) => ipcRenderer.invoke('douchat:delete-agent', agentId),
  startDirectChat: (agentId: string) => ipcRenderer.invoke('douchat:start-direct-chat', agentId),
  createGroup: (input: CreateGroupInput) => ipcRenderer.invoke('douchat:create-group', input),
  updateConversation: (conversationId: string, input: UpdateConversationInput) =>
    ipcRenderer.invoke('douchat:update-conversation', conversationId, input),
  openConversationWorkspace: (conversationId: string) => ipcRenderer.invoke('douchat:open-conversation-workspace', conversationId),
  chooseConversationWorkspace: (conversationId: string) => ipcRenderer.invoke('douchat:choose-conversation-workspace', conversationId),
  clearConversationWorkspace: (conversationId: string) => ipcRenderer.invoke('douchat:clear-conversation-workspace', conversationId),
  openConversationWindow: (conversationId: string) => ipcRenderer.invoke('douchat:open-conversation-window', conversationId),
  openCodeArtifact: (input: CodeArtifactInput) => ipcRenderer.invoke('douchat:open-code-artifact', input),
  getCodeArtifact: (artifactId: string) => ipcRenderer.invoke('douchat:get-code-artifact', artifactId),
  testEmailConnector: (input: EmailConnectorInput) => ipcRenderer.invoke('douchat:test-email-connector', input),
  saveEmailConnector: (input: EmailConnectorInput) => ipcRenderer.invoke('douchat:save-email-connector', input),
  disconnectEmailConnector: (connectorId: string) => ipcRenderer.invoke('douchat:disconnect-email-connector', connectorId),
  deleteMessage: (conversationId: string, messageId: string) => ipcRenderer.invoke('douchat:delete-message', conversationId, messageId),
  deleteConversation: (conversationId: string) => ipcRenderer.invoke('douchat:delete-conversation', conversationId),
  setConversationPinned: (conversationId: string, pinned: boolean) =>
    ipcRenderer.invoke('douchat:set-conversation-pinned', conversationId, pinned),
  markConversationRead: (conversationId: string) => ipcRenderer.invoke('douchat:mark-read', conversationId),
  markAllConversationsRead: () => ipcRenderer.invoke('douchat:mark-all-read'),
  createTopic: (conversationId: string) => ipcRenderer.invoke('douchat:create-topic', conversationId),
  renameTopic: (conversationId: string, topicId: string, title: string) =>
    ipcRenderer.invoke('douchat:rename-topic', conversationId, topicId, title),
  deleteTopic: (conversationId: string, topicId: string) =>
    ipcRenderer.invoke('douchat:delete-topic', conversationId, topicId),
  setActiveTopic: (conversationId: string, topicId: string) =>
    ipcRenderer.invoke('douchat:set-active-topic', conversationId, topicId),
  sendMessage: (conversationId: string, text: string, images?: MessageImageInput[], files?: MessageFileInput[], mentions?: SelectedMention[]) =>
    ipcRenderer.invoke('douchat:send-message', conversationId, text, images, files, mentions),
  stopConversation: (conversationId: string) => ipcRenderer.invoke('douchat:stop-conversation', conversationId),
  clearConversation: (conversationId: string) => ipcRenderer.invoke('douchat:clear-conversation', conversationId),
  resetConversationContext: (conversationId: string) => ipcRenderer.invoke('douchat:reset-conversation-context', conversationId),
  createRoutine: (input: CreateRoutineInput) => ipcRenderer.invoke('douchat:create-routine', input),
  deleteRoutine: (routineId: string) => ipcRenderer.invoke('douchat:delete-routine', routineId),
  setRoutineEnabled: (routineId: string, enabled: boolean) =>
    ipcRenderer.invoke('douchat:set-routine-enabled', routineId, enabled),
  runRoutineNow: (routineId: string) => ipcRenderer.invoke('douchat:run-routine-now', routineId),
  startComputer: (agentId: string) => ipcRenderer.invoke('douchat:start-computer', agentId),
  stopComputer: (agentId: string) => ipcRenderer.invoke('douchat:stop-computer', agentId),
  showComputer: (agentId: string) => ipcRenderer.invoke('douchat:show-computer', agentId),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on('douchat:update-state', handler)
    return () => ipcRenderer.removeListener('douchat:update-state', handler)
  },
  listProjects: () => ipcRenderer.invoke('douchat:list-projects'),
  chooseProject: () => ipcRenderer.invoke('douchat:choose-project'),
  removeProject: (id) => ipcRenderer.invoke('douchat:remove-project', id),
  projectGitStatus: (id) => ipcRenderer.invoke('douchat:project-git-status', id),
  projectGitDiff: (id, path) => ipcRenderer.invoke('douchat:project-git-diff', id, path),
  listCodingSessions: (projectId) => ipcRenderer.invoke('douchat:list-coding-sessions', projectId),
  startCodingSession: (input) => ipcRenderer.invoke('douchat:start-coding-session', input),
  cancelCodingSession: (id) => ipcRenderer.invoke('douchat:cancel-coding-session', id),
  onProjection: (listener: (delta: ProjectionDelta) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, delta: ProjectionDelta): void => listener(delta)
    ipcRenderer.on('douchat:projection', handler)
    return () => ipcRenderer.removeListener('douchat:projection', handler)
  }
}

contextBridge.exposeInMainWorld('douchat', api)
