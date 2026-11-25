/**
 * Broadcast fan-out target selection.
 *
 * Kept as a pure function (and out of `hive.ts`) so the rule is testable on its
 * own, the way `queueDelivery` is.
 */

/** The subset of a registry agent that fan-out actually looks at. */
export interface BroadcastCandidate {
  /** Michael's prep assistant — send-only, drains no inbox. */
  isAssistant?: boolean;
  /** PTY tab closed; the record is retained but the agent is not live. */
  archived?: boolean;
  /** On the roster with no session until it has work. */
  dormant?: boolean;
}

/**
 * The agents a `to: 'broadcast'` message fans out to.
 *
 * Excluded: the sender itself, the send-only prep assistant (direct mail to it
 * would rot unread), archived agents (closed tab), and every agent without a
 * live session. `live` is the set of agent ids main has a PTY for; a sleeper
 * gets nothing, not even a file on disk, so it never wakes to a stale pile of
 * floor-wide notices. `includeDormant` (the message's opt-in) adds back agents
 * the registry marks `dormant`, which keeps ghosts from a hard quit out either way.
 * With no `live` set (a HiveManager with no main process, as in tests) the
 * registry `dormant` flag stands in for "not live".
 *
 * NOT excluded: providers without a hook/proxy bridge. Fan-out used to gate on
 * `canReceiveInbox`, which meant an agent on a hookless provider — `custom`,
 * i.e. any CLI the presets don't know — silently never heard a broadcast, even
 * though a DIRECT message to that same agent was delivered fine. That asymmetry
 * was the bug: `deliver` already routes a hookless target through
 * `emitTerminalHandoff` (a terminal work order) and only bounces to the god when
 * the renderer is unavailable. Fan-out now selects live agents whatever their
 * provider, and that existing per-target path decides HOW each one is served.
 *
 * The trade-off this accepts: with the renderer down, a broadcast to N hookless
 * agents produces N bounces to the god instead of silence. That is the same
 * behaviour N direct messages already produce, and it is the loud failure —
 * nothing is dropped without the god being told.
 */
export function selectBroadcastTargets(
  agents: Record<string, BroadcastCandidate | undefined>,
  fromId: string,
  live: ReadonlySet<string> | null = null,
  includeDormant = false
): string[] {
  return Object.keys(agents).filter((id) => {
    const agent = agents[id];
    if (!agent) return false;
    if (id === fromId) return false;
    if (agent.isAssistant) return false;
    if (agent.archived) return false;
    if (live?.has(id)) return true;
    if (agent.dormant) return includeDormant;
    return !live;
  });
}
