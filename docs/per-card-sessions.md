# Fresh sessions at card handoff

Trigger: a worker reports done, a card this session worked is blocked awaiting boss merge (or done), its brief is present, and memory.md has been updated during this session. Evaluate only after Stop/Codex task_complete and the existing four-second settling delay; revalidate before closing. A doing card, new input, permission prompt, queued message/draft, hold or closing time prevents teardown.

Rule: use a fresh session at every completed-card boundary, including the last card. This extends the existing fresh-per-next-card policy rather than adding a second compaction path. With no next work, park dormant; later mail or assignment wakes it with memory.md, the card brief and the usual difficulty/model/effort selection. We deliberately avoid a context threshold or guessing whether titles are related: neither is needed when each card already promises a fresh session. Existing in-card context-trigger compaction and standup behavior remain unchanged.

Risks: a premature done message must not close an active turn; both durable handoff and the stopped state are required. Delayed outbox delivery must still work after Stop. A fresh wake must forget completion markers so archived cards cannot cause restart loops. Follow-up questions read the saved brief rather than the old transcript. Keep-running/spawn-request sessions retain their existing opt-out.

Overlap: camp-restart-worker-compact-150k is deployment of the already-merged in-card threshold, not this missing last-card handoff. No second threshold change or live app restart is included; the Boss can deploy both together.
