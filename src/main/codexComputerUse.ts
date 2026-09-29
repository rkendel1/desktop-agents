/** Native tools belong to Codex's configured MCP/plugin runtime, not Foundry's webview. */
export const codexComputerUseInstructions = [
  'Foundry supports your native Codex Computer Use tools and forwards their application-access confirmations to the human.',
  'For a requested desktop/browser task, inspect the native tool inventory before saying you only have a browser. Use the installed Computer Use plugin and its instructions when available; do not treat Foundry computer_open as native desktop control.',
  'With cua_repl, follow its entry-point documentation to get the target app or browser. A web URL or shell launch is not evidence of successful native application interaction.',
  'Honor tool denials and operating-system permissions. Report the exact failing step; ERR_ABORTED and ERR_CONNECTION_CLOSED alone do not establish a security policy. Never bypass a denied action with another tool.'
].join('\n')

export function codexComputerUseInventory(servers: unknown[]): string {
  const native = servers.filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object' &&
    ['cua_repl', 'computer-use', 'computer_use'].includes(String((s as Record<string, unknown>).name))))
  if (!native.length) return 'No native Computer Use MCP server was returned by this Codex session. Do not claim native desktop access. Ask the user to enable the Computer Use plugin in Codex/ChatGPT desktop, grant macOS Screen Recording and Accessibility when prompted, then start a new Foundry conversation. Ordinary coding tools remain usable.'
  return native.map(server => {
    const tools = server.tools && typeof server.tools === 'object' ? Object.keys(server.tools).filter(name => /^[\w.-]{1,100}$/.test(name)) : []
    const connected = (!server.runtimeStatus || server.runtimeStatus === 'connected') && !server.toolsError && tools.length > 0
    return connected
      ? `Native Computer Use MCP server ${server.name} is connected; exposed tools: ${tools.join(', ')}. This confirms tool loading, not OS permission or access to every app/browser. Try the appropriate native tool for the requested task and handle its result.`
      : `Native Computer Use MCP server ${server.name} is configured but not ready. Check its startup/connection status; do not claim desktop access or say the website is blocked. The rest of the task may continue using available tools.`
  }).join('\n')
}
