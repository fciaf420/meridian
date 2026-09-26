/**
 * Minimal environments for child processes (Codex CLI, Claude CLI, gmgn-cli).
 *
 * The bot's own process.env holds WALLET_PRIVATE_KEY, RPC_URL and every API
 * key (Helius, Jupiter, LP Agent, DeepSeek, GMGN, SolanaTracker, Telegram).
 * None of that belongs in an LLM CLI subprocess. Each child gets an allowlist:
 * what a process needs to run at all (PATH, HOME, locale, temp dir, terminal,
 * proxy/CA settings to reach its API), plus the named variables its own CLI
 * reads. Everything else is dropped.
 *
 * How the CLIs authenticate (checked against the installed versions):
 * - codex: OAuth or API key saved by `codex login` in $CODEX_HOME/auth.json
 *   (default ~/.codex). Needs HOME (or CODEX_HOME), no key variable.
 * - claude: OAuth login saved under ~/.claude (or $CLAUDE_CONFIG_DIR), or the
 *   macOS Keychain. Needs HOME/USER. CLAUDE_CODE_OAUTH_TOKEN (from
 *   `claude setup-token`) is passed through only when set, because it is that
 *   CLI's own login and grants nothing on-chain.
 * - gmgn-cli: GMGN_API_KEY only (it also reads ~/.config/gmgn/.env itself).
 *
 * A final pattern filter drops any secret-looking name even if a future edit
 * adds it to an allowlist, except the per-CLI names listed as SECRET_EXCEPTIONS.
 */

const BASE_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE", "TZ",
  "TMPDIR", "TMP", "TEMP",
  "TERM", "COLORTERM", "NO_COLOR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Networking: a CLI behind a proxy or a corporate CA can't reach its API without these.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  // Windows process basics (the CLI launch code supports win32).
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

const BASE_PREFIXES = ["LC_"];

/** Extra variables each CLI reads for its own config/login. */
const CLI_KEYS = {
  codex: ["CODEX_HOME"],
  claude: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"],
  gmgn: ["GMGN_API_KEY"],
};

/** Secret-looking names that a CLI legitimately needs (its own login only). */
const SECRET_EXCEPTIONS = {
  codex: new Set(),
  claude: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
  gmgn: new Set(["GMGN_API_KEY"]),
};

const SECRET_NAME = /(PRIVATE|SECRET|PASSWORD|PASSPHRASE|MNEMONIC|SEED|WALLET|_KEY$|^KEY$|_KEYS$|APIKEY|TOKEN|RPC_URL|CREDENTIAL)/i;

function isAllowed(name, cli, upper) {
  if (BASE_KEYS.some((k) => (upper ? k === name.toUpperCase() : k === name))) return true;
  if (BASE_PREFIXES.some((p) => name.startsWith(p))) return true;
  return (CLI_KEYS[cli] || []).includes(name);
}

/**
 * Environment for a child CLI: only allowlisted variables from `source`.
 * @param {"codex"|"claude"|"gmgn"} cli
 * @param {object} [source] defaults to process.env
 * @param {string} [platform] defaults to process.platform (win32 env names are case-insensitive)
 */
export function buildCliEnv(cli, source = process.env, platform = process.platform) {
  if (!CLI_KEYS[cli]) throw new Error(`buildCliEnv: unknown CLI "${cli}"`);
  const upper = platform === "win32";
  const exceptions = SECRET_EXCEPTIONS[cli];
  const env = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (value == null) continue;
    if (!isAllowed(name, cli, upper)) continue;
    if (SECRET_NAME.test(name) && !exceptions.has(name)) continue;
    env[name] = String(value);
  }
  return env;
}
