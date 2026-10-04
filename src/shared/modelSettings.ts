import type { ModelIdentityKind, ModelOption, ReasoningControl } from './types.js';

/**
 * Model identity and advanced-setting capability rules shared by the Workflow Studio and the
 * run engine. The UI only offers settings listed here for the selected backend/model, and the
 * engine refuses anything outside the same list, so a hidden stale setting can never be sent.
 */

const CLAUDE_CODE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'default', 'best', 'opusplan']);

export function classifyModelIdentity(
  backendId: string | undefined,
  modelId: string | undefined,
): ModelIdentityKind {
  const id = (modelId ?? '').trim();
  if (!id) return 'pinned';
  const lower = id.toLowerCase();
  if (lower.startsWith('~')) return 'floating';
  if (/(^|[/:@_.-])latest$/.test(lower)) return 'floating';
  if (lower === 'openrouter/auto' || lower.endsWith('/auto')) return 'floating';
  if (backendId === 'claude-code' && CLAUDE_CODE_ALIASES.has(lower.replace(/\[.*\]$/, ''))) return 'floating';
  return 'pinned';
}

export interface AdvancedSettingDescriptor {
  key: string;
  label: string;
  kind: 'enum' | 'number';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  help: string;
}

/** Documented OpenRouter `reasoning.effort` values (verified 2026-10-02). */
export const OPENROUTER_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function reasoningControlFor(
  backendId: string | undefined,
  model: ModelOption | undefined,
): ReasoningControl {
  if (!backendId) return 'none';
  if (model?.reasoningControl) return model.reasoningControl;
  if (backendId === 'codex-cli') return model?.reasoningLevels?.length ? 'effort' : 'provider-controlled';
  if (backendId === 'opencode') return model?.variantIds?.length ? 'variant' : 'provider-controlled';
  if (backendId === 'openrouter')
    return model?.reasoningLevels?.length ? 'effort' : model ? 'none' : 'provider-controlled';
  // Claude Code and Cline expose no account model catalog to this adapter, so reasoning stays provider controlled.
  return 'provider-controlled';
}

export function advancedSettingsFor(
  backendId: string | undefined,
  model: ModelOption | undefined,
): AdvancedSettingDescriptor[] {
  if (backendId !== 'openrouter' || !model) return [];
  const settings: AdvancedSettingDescriptor[] = [];
  if (model.supportsMaxOutput && model.maxOutputRange)
    settings.push({
      key: 'maxOutputTokens',
      label: 'Maximum output tokens',
      kind: 'number',
      min: model.maxOutputRange.min,
      max: model.maxOutputRange.max,
      step: 1,
      help: 'Bounds output and therefore the conservative metered reservation.',
    });
  if (model.reasoningBudgetRange)
    settings.push({
      key: 'reasoningMaxTokens',
      label: 'Reasoning budget (tokens)',
      kind: 'number',
      min: model.reasoningBudgetRange.min,
      max: model.reasoningBudgetRange.max,
      step: 1,
      help: 'Sent as reasoning.max_tokens. Reasoning tokens are billed as output.',
    });
  if (model.supportsTemperature && model.temperatureRange)
    settings.push({
      key: 'temperature',
      label: 'Temperature',
      kind: 'number',
      min: model.temperatureRange.min,
      max: model.temperatureRange.max,
      step: 0.05,
      help: 'Only sent when set.',
    });
  return settings;
}

/** Native keys accepted for backward compatibility but not shown as separate controls. */
function legacyNativeKeys(backendId: string | undefined): string[] {
  return backendId === 'codex-cli' ? ['reasoningEffort'] : [];
}

export function validateModelSettings(args: {
  backendId: string | undefined;
  model: ModelOption | undefined;
  catalogAvailable: boolean;
  reasoning?: string;
  variantId?: string;
  nativeSettings?: Record<string, string | number | boolean | null>;
}): string[] {
  const errors: string[] = [];
  const control = reasoningControlFor(args.backendId, args.model);
  if (args.reasoning) {
    if (control !== 'effort')
      errors.push(
        `Reasoning “${args.reasoning}” cannot be sent: this model's reasoning is ${control === 'variant' ? 'selected through a provider-native variant' : control === 'none' ? 'not configurable' : 'provider controlled'}.`,
      );
    else if (args.catalogAvailable && !args.model?.reasoningLevels?.includes(args.reasoning))
      errors.push(`Reasoning “${args.reasoning}” is not reported as supported for this exact model.`);
  }
  if (args.variantId && args.catalogAvailable && !args.model?.variantIds?.includes(args.variantId))
    errors.push(`Variant “${args.variantId}” is not reported as supported for this exact model.`);
  const descriptors = advancedSettingsFor(args.backendId, args.model);
  const allowed = new Set([...descriptors.map((item) => item.key), ...legacyNativeKeys(args.backendId)]);
  for (const [key, value] of Object.entries(args.nativeSettings ?? {})) {
    if (value === null || value === undefined) continue;
    if (!allowed.has(key)) {
      errors.push(
        `Setting “${key}” is not a supported capability of this backend/model and will not be sent.`,
      );
      continue;
    }
    const descriptor = descriptors.find((item) => item.key === key);
    if (descriptor?.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        errors.push(`${descriptor.label} must be a number.`);
      else if (
        (descriptor.min !== undefined && value < descriptor.min) ||
        (descriptor.max !== undefined && value > descriptor.max)
      )
        errors.push(`${descriptor.label} must be between ${descriptor.min} and ${descriptor.max}.`);
    }
    if (descriptor?.kind === 'enum' && !descriptor.options?.includes(String(value)))
      errors.push(`${descriptor.label} value “${String(value)}” is not supported.`);
  }
  if (args.backendId === 'codex-cli') {
    const nativeEffort = args.nativeSettings?.reasoningEffort;
    if (typeof nativeEffort === 'string' && args.reasoning && nativeEffort !== args.reasoning)
      errors.push(
        'Choose one provider-native reasoning value; conflicting reasoning settings were configured.',
      );
    if (
      typeof nativeEffort === 'string' &&
      !args.reasoning &&
      args.catalogAvailable &&
      !args.model?.reasoningLevels?.includes(nativeEffort)
    )
      errors.push(`Reasoning “${nativeEffort}” is not reported as supported for this exact model.`);
  }
  return errors;
}

/**
 * When the backend or model changes, drop every setting the new selection does not support rather
 * than silently carrying it forward.
 */
export function pruneModelSettings(args: {
  backendId: string | undefined;
  model: ModelOption | undefined;
  reasoning?: string;
  variantId?: string;
  nativeSettings?: Record<string, string | number | boolean | null>;
}): {
  reasoning: string | undefined;
  variantId: string | undefined;
  nativeSettings: Record<string, string | number | boolean | null> | undefined;
} {
  const control = reasoningControlFor(args.backendId, args.model);
  const reasoning =
    control === 'effort' && args.reasoning && args.model?.reasoningLevels?.includes(args.reasoning)
      ? args.reasoning
      : undefined;
  const variantId =
    args.variantId && args.model?.variantIds?.includes(args.variantId) ? args.variantId : undefined;
  const allowed = new Set(advancedSettingsFor(args.backendId, args.model).map((item) => item.key));
  const kept = Object.fromEntries(
    Object.entries(args.nativeSettings ?? {}).filter(([key]) => allowed.has(key)),
  );
  return { reasoning, variantId, nativeSettings: Object.keys(kept).length ? kept : undefined };
}

export function reasoningControlLabel(control: ReasoningControl): string {
  return control === 'effort'
    ? 'Provider-native effort'
    : control === 'variant'
      ? 'Provider-native variant'
      : control === 'budget'
        ? 'Reasoning budget'
        : control === 'provider-controlled'
          ? 'Provider controlled'
          : 'Not configurable';
}
