/**
 * The store slice the primary window publishes to the desktop windows and the phone view.
 *
 * Applied with `useStore.setState`, never through store actions: the actions
 * persist the roster, and a desktop window must not write one (main refuses it
 * anyway, see src/main/desktop.ts).
 */
import { useEffect } from 'react';
import { useStore, type Agent } from '@/store/store';

interface DesktopState {
  agents: Agent[];
  /** Dormant floor agents: asleep until assigned work, so the feedback picker can still list them. */
  restorableAgents: Agent[];
  selectedId: string | null;
  officeTheme: ReturnType<typeof useStore.getState>['officeTheme'];
}

const PUBLISH_MS = 200;

function snapshot(): DesktopState {
  const s = useStore.getState();
  return { agents: s.agents, restorableAgents: s.restorableAgents, selectedId: s.selectedId, officeTheme: s.officeTheme };
}

function apply(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as DesktopState).agents)) return;
  const st = raw as DesktopState;
  useStore.setState({ agents: st.agents, restorableAgents: Array.isArray(st.restorableAgents) ? st.restorableAgents : [], selectedId: st.selectedId, officeTheme: st.officeTheme });
}

/** Primary window: publish the slice to main, for the desktop windows and the phone view. */
export function useDesktopPublisher(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => { timer = null; window.cth.desktopPublish(snapshot()); };
    publish();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.agents === prev.agents && s.restorableAgents === prev.restorableAgents && s.selectedId === prev.selectedId && s.officeTheme === prev.officeTheme) return;
      if (!timer) timer = setTimeout(publish, PUBLISH_MS);
    });
    // Entering desktop mode wants a fresh snapshot, not the next change.
    const off = window.cth.onDesktopMode((on) => { if (on) publish(); });
    // A chat message from the desktop talk pop-up, enqueued as the composer would.
    const offEnqueue = window.cth.onDesktopEnqueue(({ agentId, text }) => {
      useStore.getState().enqueueMessage(agentId, text);
      void window.cth.trackMessageSent('composer');
    });
    return () => { unsub(); off(); offEnqueue(); if (timer) clearTimeout(timer); };
  }, []);
}

/** Desktop windows: follow the primary's published slice. */
export function useDesktopMirror(): void {
  useEffect(() => {
    void window.cth.desktopGetState().then(apply);
    return window.cth.onDesktopState(apply);
  }, []);
}

/** Primary: keep each agent's last reply on it, from the transcript main reads at Stop. */
export function useLastReplies(): void {
  useEffect(() => window.cth.onHiveLastReply(({ agentId, text }) => {
    if (!useStore.getState().agents.some((a) => a.id === agentId)) return;
    useStore.getState().updateAgent(agentId, { recentAssistantText: text, recentTextTs: Date.now() });
  }), []);
}
