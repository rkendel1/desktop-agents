import { findCodexDesktopExecutable } from './codexDesktop';
import { managedSearchPaths } from './managedNode';
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";

/** Sentinel so rc-file chatter on stdout can't be mistaken for the answer. */
const MARKER = "__termany_shell__";

function loginShell(): string {
  return process.env.SHELL || (IS_WIN ? "cmd.exe" : "/bin/zsh");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function capture(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(MARKER))
    .pop();
  const value = line?.slice(MARKER.length).trim();
  return value || undefined;
}

/**
 * Evaluate a shell expression in the user's login shell and return its value.
 *
 * `-lc` alone is not enough: a non-interactive zsh reads .zshenv, .zprofile and
 * .zlogin but *skips ~/.zshrc*, which is exactly where CLI installers (opencode,
 * pnpm, nvm, ~/.local/bin) append to PATH. Terminal panes never hit this because
 * node-pty hands the shell a tty, so `zsh -l` is interactive there. Prefer the
 * interactive form: even an incomplete non-interactive PATH is nonempty.
 * Fall back to the quiet form if interactive startup fails.
 */
async function loginShellValue(expression: string): Promise<string | undefined> {
  const shell = loginShell();
  const script = `printf '%s%s\\n' ${shellQuote(MARKER)} "${expression}"`;
  for (const flags of ["-lic", "-lc"]) {
    try {
      const { stdout } = await execFileAsync(shell, [flags, script], {
        timeout: 5_000,
        killSignal: "SIGKILL",
        // An interactive rc file can print a banner; keep it from blowing up.
        maxBuffer: 1_024 * 1_024,
      });
      const value = capture(stdout);
      if (value) return value;
    } catch {
      // Try the next form; the caller reports the failure in context.
    }
  }
  return undefined;
}

let cachedPath: Promise<string | undefined> | undefined;
let cachedCliEnvironment: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * Finder/Explorer-launched desktop apps do not inherit variables exported by a
 * terminal startup file. Keep this list deliberately narrow: these are model
 * CLI configuration values that the same user-owned CLI would already receive
 * when launched in Terminal. They are passed only to child agent processes and
 * are never persisted or logged by Foundry.
 */
const CLI_ENVIRONMENT_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GEMINI_API_KEY",
  "NANOBANANA_API_KEY",
  "NANOBANANA_GEMINI_API_KEY",
  "NANOBANANA_GOOGLE_API_KEY",
  "NANOBANANA_MODEL",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
] as const;

async function loginShellCliEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (IS_WIN) return {};
  const entries = await Promise.all(CLI_ENVIRONMENT_NAMES.map(async (name) => {
    const value = await loginShellValue(`$${name}`);
    return value ? [name, value] as const : undefined;
  }));
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of entries) {
    if (entry) environment[entry[0]] = entry[1];
  }
  return environment;
}

/**
 * The PATH a login terminal would see, cached for the life of the process.
 *
 * Child agents spawned by the server inherit the app's environment, which in a
 * Finder-launched macOS bundle is the bare launchd PATH — no node, no npx, no
 * user bin directories.
 */
export function resetShellPath(): void {
  cachedPath = undefined;
  cachedCliEnvironment = undefined;
}

export function loginShellPath(): Promise<string | undefined> {
  if (IS_WIN) return Promise.resolve(undefined);
  cachedPath ??= loginShellValue("$PATH").catch(() => undefined);
  return cachedPath;
}

async function childDirectories(parent: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => path.join(parent, entry.name, suffix));
  } catch {
    return [];
  }
}

/**
 * Finder-launched apps sometimes cannot start an interactive shell at all
 * (broken rc file, removed shell, or a version manager waiting for a TTY).
 * These are the conventional executable locations used by the installers we
 * support. They are fallbacks, not replacements for the user's shell PATH.
 */
async function executableSearchPath(): Promise<string> {
  const shellPath = await loginShellPath();
  if (IS_WIN) return [...managedSearchPaths(), process.env.PATH || ""].join(path.delimiter);
  const home = os.homedir();
  // A custom npm prefix can disappear from PATH when shell startup times out.
  // Read only its location; never run npm or load registry credentials here.
  const npmrc = await fs.promises.readFile(path.join(home, ".npmrc"), "utf8").catch(() => "");
  const configuredPrefix = npmrc.match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
  const npmPrefix = configuredPrefix?.replace(/^~(?=\/)/, home);
  const nvmBins = await childDirectories(path.join(home, ".nvm", "versions", "node"), "bin");
  const candidates = [
    ...managedSearchPaths(),
    ...(shellPath || "").split(path.delimiter),
    ...(process.env.PATH || "").split(path.delimiter),
    ...(npmPrefix && path.isAbsolute(npmPrefix) ? [path.join(npmPrefix, "bin")] : []),
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".fnm", "aliases", "default", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".kimi-code", "bin"),
    ...nvmBins,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  return [...new Set(candidates)].join(path.delimiter);
}

/** PATH-repaired environment for a child process spawned outside a PTY. */
export async function executableEnvironment(): Promise<NodeJS.ProcessEnv> {
  const repairedPath = await executableSearchPath();
  return { ...process.env, PATH: repairedPath };
}

export async function spawnEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = await executableEnvironment();
  cachedCliEnvironment ??= loginShellCliEnvironment().catch(() => ({}));
  const cliEnvironment = await cachedCliEnvironment;
  return { ...environment, ...cliEnvironment };
}

/**
 * An executable script can pass X_OK and still fail with ENOENT when the
 * interpreter named by its shebang has been removed. This commonly happens to
 * uv/pipx tools after Homebrew replaces a Python installation.
 */
async function isRunnable(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path, fs.constants.X_OK);
    if (IS_WIN) return true;

    const handle = await fs.promises.open(path, "r");
    try {
      const buffer = Buffer.alloc(1_024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
      if (!firstLine.startsWith("#!")) return true;

      const interpreter = firstLine.slice(2).trim().split(/\s+/, 1)[0];
      if (!interpreter) return false;
      await fs.promises.access(interpreter, fs.constants.X_OK);
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Absolute path of `command`, resolved the way the user's shell would.
 * Returns undefined when nothing matches or a script's shebang interpreter is
 * missing, since the operating system cannot start that command either.
 */
export async function resolveExecutable(command: string): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (/[\\/]/.test(trimmed)) {
    return await isRunnable(trimmed) ? trimmed : undefined;
  }
  if (IS_WIN) {
    for (const directory of managedSearchPaths()) {
      for (const extension of /\.(exe|com|cmd|bat)$/i.test(trimmed) ? [''] : ['.exe', '.cmd', '.bat']) {
        const candidate = path.join(directory, trimmed + extension);
        if (await isRunnable(candidate)) return candidate;
      }
    }
    try {
      const { stdout } = await execFileAsync("where.exe", [trimmed], { timeout: 2_500, killSignal: "SIGKILL" });
      const matches = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      // npm also installs extensionless POSIX scripts; Windows cannot execute those.
      const match = matches.find((file) => /\.(?:exe|com|cmd|bat)$/i.test(file));
      if (match) return match;
    } catch {
      // An installer may have changed PATH since the desktop app started.
    }
    const home = os.homedir();
    const npmrc = await fs.promises.readFile(path.join(home, '.npmrc'), 'utf8').catch(() => '');
    const prefix = npmrc.match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
    const directories = [prefix, process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.kimi-code', 'bin'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs')].filter((value): value is string => Boolean(value));
    const extensions = /\.(exe|com|cmd|bat)$/i.test(trimmed) ? [''] : ['.exe', '.cmd', '.bat', '.com'];
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory, trimmed + extension);
        if (await isRunnable(candidate)) return candidate;
      }
    }
    return trimmed.toLowerCase() === 'codex' ? findCodexDesktopExecutable() : undefined;
  }
  // Search the same PATH passed to child processes. `command -v` can return
  // alias/function descriptions, which cannot be launched with execFile.
  const env = await executableEnvironment();
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", trimmed);
    if (await isRunnable(candidate)) return candidate;
  }
  return trimmed === 'codex' ? findCodexDesktopExecutable() : undefined;
}
