/**
 * Central model registry.
 *
 * Model ids are full model names (not the legacy `sonnet` / `opus` aliases),
 * so they are passed straight through to `claude --model <id>`. This matters
 * when running behind a third-party API proxy that only accepts exact names.
 */

export type ModelId =
  | "claude-opus-5-5"
  | "claude-sonnet-5-5"
  | "claude-haiku-5-5"
  | "claude-fable-5-2";

export interface ModelOption {
  id: ModelId;
  name: string;
  shortName: string;
  description: string;
}

export const MODELS: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    shortName: "O",
    description: "Most capable, best for complex tasks",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    shortName: "S",
    description: "Balanced speed and capability",
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    shortName: "H",
    description: "Fastest, cheapest for simple tasks",
  },
  {
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    shortName: "F",
    description: "Creative writing and prose oriented",
  },
];

export const DEFAULT_MODEL: ModelId = "claude-opus-5-5";

const MODELS_BY_ID: Record<string, ModelOption> = MODELS.reduce(
  (acc, m) => {
    acc[m.id] = m;
    return acc;
  },
  {} as Record<string, ModelOption>
);

/**
 * Legacy ids stored in the database before full model names were used.
 * Mapped to the closest current equivalent so old agents/sessions keep working.
 */
const LEGACY_ALIASES: Record<string, ModelId> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  "opus-4": "claude-opus-5-5",
  "sonnet-4": "claude-sonnet-5-5",
  "claude-opus-4": "claude-opus-5-5",
  "claude-sonnet-4": "claude-sonnet-5-5",
};

/** Resolve any stored value (legacy alias or full id) into a usable model id. */
export function normalizeModelId(model?: string | null): ModelId {
  if (!model) return DEFAULT_MODEL;
  if (MODELS_BY_ID[model]) return model as ModelId;
  const legacy = LEGACY_ALIASES[model.toLowerCase()];
  if (legacy) return legacy;
  // Unknown value: keep it, the CLI may still understand it.
  return model as ModelId;
}

/** Human readable label for any stored model value. */
export function getModelLabel(model?: string | null): string {
  if (!model) return "Unknown model";
  const opt = MODELS_BY_ID[model];
  if (opt) return opt.name;
  const normalized = normalizeModelId(model);
  const found = MODELS_BY_ID[normalized];
  return found ? found.name : model;
}

export function getModelShortName(model?: string | null): string {
  const opt = MODELS_BY_ID[normalizeModelId(model)];
  return opt ? opt.shortName : "?";
}
