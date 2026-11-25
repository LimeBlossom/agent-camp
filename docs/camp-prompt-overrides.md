# Camp prompt overrides

To replace one bundled prompt section, create `<hive>/prompts/sections/<key>.md`.
The file is read at each agent spawn. Changes apply to the next spawn, while edits to
`PROTOCOL.md` and `PROTOCOL-BOSS.md` are available to running agents when they read them.

Section keys are `ledgerLine`, `guardrailsLine`, `visualChecksLine` (workers only),
`memoryLine`, `knowledgeLine`, `vaultLine`, `godLine`, `spawnQueueLine`, `unityLine`, `toolsLine`, `runtimeLine`,
`slackLine`, and `ctxLine`. For example, `guardrailsLine.md` might contain:

```text
Guardrails for {{name}} ({{id}}): follow the safety rules in {{root}}/PROTOCOL.md.
```

Templates support `{{name}}`, `{{id}}`, `{{dir}}`, `{{root}}`, and `{{tools}}`.
Missing or unreadable files use the bundled section. An empty file suppresses that
section. Other sections keep their own overrides or bundled text.

Conditional sections still require their feature: semantic memory, knowledge graph,
vault-inbox directory, Unity access, available tools, or runtime information.
`spawnQueueLine` requires the Boss role and permission to spawn. `godLine` applies
only to the Boss; workers and prep assistants keep their own role instructions.

Existing `<hive>/prompts/boss.md` and `worker.md` files take precedence and replace
the entire prompt, including its sections. Use section files with the bundled prompt
when you want to retain its other sections and conditional behavior.
