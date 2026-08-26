import { TemplateReader } from "./template-loader";

// Resolving the theme's `settings` object the way Shopify does. Ported verbatim from the
// Shopforge preview renderer.
//
// `config/settings_data.json` only stores settings a merchant has actually changed — every
// other setting falls back to the `default` in `config/settings_schema.json`.
//
// Skipping that fallback does not degrade gracefully: the layout computes
// `--font-body-scale: {{ settings.body_scale | divided_by: 100.0 }}`, and Liquid evaluates
// `nil | divided_by: 100.0` as 0, so the root `font-size: calc(var(--font-body-scale) *
// 62.5%)` resolves to 0px. Every `rem` in the theme then measures 0 and the entire page
// collapses to zero width and height while its text remains in the DOM — a blank preview.

interface SchemaGroup {
  name?: string;
  settings?: { id?: string; default?: unknown }[];
}

/** Every `id: default` pair declared across the schema's groups. */
export function schemaDefaults(schema: SchemaGroup[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const group of schema) {
    for (const setting of group.settings ?? []) {
      if (setting.id && "default" in setting) defaults[setting.id] = setting.default;
    }
  }
  return defaults;
}

/**
 * `settings_data.json`'s `current` is either the settings object itself or the name of a
 * preset defined in the same file.
 */
export function currentSettings(data: Record<string, unknown>): Record<string, unknown> {
  const current = data.current;
  if (typeof current === "string") {
    const presets = data.presets as Record<string, Record<string, unknown>> | undefined;
    return presets?.[current] ?? {};
  }
  return (current as Record<string, unknown>) ?? {};
}

/** Merchant-saved settings win; anything absent falls back to its schema default. */
export function mergeThemeSettings(
  data: Record<string, unknown>,
  schema: SchemaGroup[],
): Record<string, unknown> {
  return { ...schemaDefaults(schema), ...currentSettings(data) };
}

export async function loadThemeSettings(readTemplate: TemplateReader): Promise<Record<string, unknown>> {
  const read = async <T>(path: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readTemplate(path)) as T;
    } catch {
      return fallback;
    }
  };
  const [data, schema] = await Promise.all([
    read<Record<string, unknown>>("config/settings_data.json", {}),
    read<SchemaGroup[]>("config/settings_schema.json", []),
  ]);
  return mergeThemeSettings(data, schema);
}
