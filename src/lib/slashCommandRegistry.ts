/**
 * Live slash-command registry.
 *
 * The claude CLI reports every command it exposes in its `system/init` event
 * (native commands, user commands, skills and plugin commands all mixed
 * together). The persistent-session reader forwards that list through a
 * `claude-init` event; we cache it here so the picker can render the real
 * command set instead of the three hardcoded defaults.
 */

let liveCommands: string[] = [];
const listeners = new Set<() => void>();

const STORAGE_KEY = "opcode.liveSlashCommands.v1";

function sortCommands(names: string[]): string[] {
  return Array.from(new Set(names.filter(Boolean))).sort((a, b) => {
    const aCore = CORE_COMMANDS.has(a) ? 0 : 1;
    const bCore = CORE_COMMANDS.has(b) ? 0 : 1;
    if (aCore !== bCore) return aCore - bCore;
    return a.localeCompare(b);
  });
}

/**
 * The CLI only reports its command list after the first message of a session,
 * so the list is persisted: opening the picker in a fresh tab (or after an app
 * restart) still shows the real commands instead of the three built-in stubs.
 */
function loadPersisted(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? sortCommands(parsed.filter((v) => typeof v === "string")) : [];
  } catch {
    return [];
  }
}

function persist(names: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // storage disabled: the in-memory list still works for this run
  }
}

liveCommands = loadPersisted();

/**
 * Commands shipped by the CLI itself, as opposed to skills/plugins that happen
 * to be registered as slash commands. Used only for ordering — everything is
 * still selectable.
 */
const CORE_COMMANDS = new Set([
  "agents",
  "autocompact",
  "batch",
  "clear",
  "code-review",
  "color",
  "compact",
  "config",
  "context",
  "debug",
  "doctor",
  "effort",
  "fast",
  "focus",
  "goal",
  "init",
  "insights",
  "list-agents",
  "mcp",
  "model",
  "output-style",
  "recap",
  "reload-plugins",
  "reload-skills",
  "rename",
  "run",
  "security-review",
  "simplify",
  "usage",
  "verify",
]);

export function isCoreCommand(name: string): boolean {
  return CORE_COMMANDS.has(name);
}

export function setLiveSlashCommands(names: string[]): void {
  const next = sortCommands(names);

  if (next.length === liveCommands.length && next.every((n, i) => n === liveCommands[i])) {
    return;
  }

  liveCommands = next;
  persist(next);
  listeners.forEach((listener) => listener());
}

export function getLiveSlashCommands(): string[] {
  return liveCommands;
}

export function subscribeLiveSlashCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
