/**
 * The recommended settings published in remote-config.json, compared with
 * the user's own. The user picks which recommendations to take; the ones
 * turned down are remembered by value, so the startup prompt stays quiet
 * until the recommendation itself changes.
 *
 * Kept free of electron imports so it can be tested under plain node.
 */

export interface ConfigChange {
    key: string;
    configKey: string;
    oldValue: string;
    newValue: string;
}

/** The settings remote-config.json can recommend. */
export interface RecommendableSettings {
    models: Record<string, string>;
    codexReasoningEffort: string;
    codexVerbosity: string;
    ccEffortLevel: string;
}

/** configKey → the recommended value the user turned down. */
export type DeclinedRecommendations = Record<string, string>;

/** Claude Code's effort levels, as its docs and `/effort` spell them. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);

/**
 * A known effort level in the lower-case form Claude Code documents
 * (remote-config.json has shipped "MAX"). Anything else comes back trimmed
 * but otherwise untouched, in case cc adds a level; blank → null.
 */
export function normalizeEffortLevel(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const level = value.trim().toLowerCase();
    return EFFORT_LEVELS.has(level) ? level : value.trim();
}

/** Every recommendation that differs from the user's current settings. */
export function diffRemoteConfig(remote: any, local: RecommendableSettings): ConfigChange[] {
    const changes: ConfigChange[] = [];
    const push = (key: string, configKey: string, oldValue: string, newValue: string) => {
        if (oldValue !== newValue) {
            changes.push({ key, configKey, oldValue: oldValue || '(未设置)', newValue });
        }
    };
    if (!remote || typeof remote !== 'object') return changes;

    if (remote.models && typeof remote.models === 'object') {
        for (const [provider, model] of Object.entries(remote.models)) {
            if (typeof model === 'string' && model) {
                push(`模型 (${provider})`, `models.${provider}`, local.models[provider] || '', model);
            }
        }
    }
    if (typeof remote.codexReasoningEffort === 'string') {
        push('Codex Reasoning Effort', 'codexReasoningEffort', local.codexReasoningEffort, remote.codexReasoningEffort);
    }
    if (typeof remote.codexVerbosity === 'string') {
        push('Codex Verbosity', 'codexVerbosity', local.codexVerbosity, remote.codexVerbosity);
    }
    const effort = normalizeEffortLevel(remote.ccEffortLevel);
    if (effort) {
        const current = normalizeEffortLevel(local.ccEffortLevel) ?? local.ccEffortLevel;
        push('Claude Code Effort Level', 'ccEffortLevel', current, effort);
    }
    return changes;
}

/** The changes still worth asking about: not turned down at this same value. */
export function pendingChanges(changes: ConfigChange[], declined: DeclinedRecommendations): ConfigChange[] {
    return changes.filter(change => declined[change.configKey] !== change.newValue);
}

/**
 * Take the `accepted` changes into `local`; remember the rest as declined.
 * A later acceptance clears an earlier refusal of the same key.
 */
export function resolveChanges(
    local: RecommendableSettings,
    changes: ConfigChange[],
    accepted: string[],
    declined: DeclinedRecommendations,
): { settings: RecommendableSettings; declined: DeclinedRecommendations } {
    const settings = { ...local, models: { ...local.models } };
    const nextDeclined = { ...declined };
    for (const change of changes) {
        if (!accepted.includes(change.configKey)) {
            nextDeclined[change.configKey] = change.newValue;
            continue;
        }
        delete nextDeclined[change.configKey];
        if (change.configKey.startsWith('models.')) {
            settings.models[change.configKey.slice('models.'.length)] = change.newValue;
        } else {
            (settings as any)[change.configKey] = change.newValue;
        }
    }
    return { settings, declined: nextDeclined };
}
