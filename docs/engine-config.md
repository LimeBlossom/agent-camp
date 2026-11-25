# Engine configuration

The human can set `engines` and `engineThresholds` in Electron's user-data `config.json`.
These fields are optional; omitted engine entries and fields keep their defaults.
The spawn queue reads current config for every request. Boss prompt and bundled
protocol generation read the same engine table on each spawn. Normal protocol
hash protection still preserves local protocol edits; with custom engine settings,
the Boss prompt also includes the current engine descriptions.

```json
{
  "engines": {
    "agy": {
      "model": "gemini-3.8-flash-high",
      "description": "Gemini Flash"
    }
  },
  "engineThresholds": {
    "fullPercent": 85,
    "headroomMargin": 30,
    "resetSoonMs": 900000
  }
}
```

The engine table accepts `model`, `description`, and a known CLI `provider` for
`agy`, `agy-claude`, `agy-argon`, `codex`, and `claude`. IDs remain compiled and
cannot be overridden. The spawn alias allowlist remains `agy` (also `antigravity`),
`agy-claude`, `codex`, and `claude`; `agy-argon` remains a persistent-agent meter.
Descriptions are operator-authored labels; update them when changing a model.
An explicit spawn-request `model` continues to override the engine's default.

`fullPercent` is the used-window cutoff (greater than zero, at most 100).
`headroomMargin` is the pace difference in percentage points needed to leave a
persistent agent's preferred engine. `resetSoonMs` is the window-reset discount
in milliseconds. Margin and reset discount accept zero; invalid, negative, or
nonfinite values fall back per field. These thresholds also apply to persistent
agent balancing and quota-driven switching. Exhaustion at 100% remains enforced.

Without these config fields, model pins, selection rules, default Boss prompts,
and bundled protocol text retain their existing values. Installing this code
requires a rebuild; subsequent config edits use the existing config reload path.
