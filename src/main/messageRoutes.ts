import type { HarnessConfig } from './config';

/**
 * Message routing map for Camp engine notices and automated dispatches.
 *
 * All route keys are optional; when omitted or set to 'god', they resolve to
 * the god/orchestrator agent ID on the floor (e.g. 'god' or 'michael-xxx').
 * Configured recipients can be agent IDs (e.g. 'birch', 'quince') or
 * aliases ('god', 'boss', 'human').
 */
export interface MessageRoutesConfig {
  /** Recipient for worker lifecycle notices (crashed, reaped, reclaimed, spawn rejected, spawned). Default 'god'. */
  workerLifecycle?: string;
  /** Recipient for generic inbound webhook intake tasks. Default 'god'. */
  webhook?: string;
  /** Recipient for floor heartbeat / quiet floor re-engagement prompts. Default 'god'. */
  heartbeat?: string;
  /** Recipient for wrap-up/closing-time unpark summaries and conclusion notes. Default 'god'. */
  wrapUp?: string;
  /** Extension routes for custom integrations or future camp dispatches. */
  [routeKey: string]: string | undefined;
}

/** Canonical defaults routing all harness dispatches to god. */
export const DEFAULT_MESSAGE_ROUTES: Readonly<Required<MessageRoutesConfig>> = Object.freeze({
  workerLifecycle: 'god',
  webhook: 'god',
  heartbeat: 'god',
  wrapUp: 'god'
});

/**
 * The recipient configured for a route key. A missing key, a blank value, or (when `isKnown` is given)
 * an agent id that is not on the floor falls back to 'god'.
 */
export function getMessageRoute(
  routeKey: string,
  config?: Partial<HarnessConfig> | null,
  isKnown?: (agentId: string) => boolean
): string {
  const custom = config?.routes?.[routeKey];
  if (typeof custom === 'string' && custom.trim().length > 0) {
    const to = custom.trim();
    if (!isKnown || ALIASES.has(to) || isKnown(to)) return to;
  }
  return DEFAULT_MESSAGE_ROUTES[routeKey as keyof MessageRoutesConfig] ?? 'god';
}

const ALIASES: ReadonlySet<string> = new Set(['human', 'god', 'boss']);

/**
 * Resolves an agent alias ('human', 'god', 'boss') to the concrete godId.
 */
export function resolveRecipient(to: string, godId = 'god'): string {
  return ALIASES.has(to) ? godId : to;
}

/**
 * Resolves the effective target recipient for a given route key, taking config
 * and godId into account. Read dynamically per send.
 */
export function resolveRouteRecipient(
  routeKey: string,
  config?: Partial<HarnessConfig> | null,
  godId = 'god'
): string {
  const target = getMessageRoute(routeKey, config);
  return resolveRecipient(target, godId);
}
