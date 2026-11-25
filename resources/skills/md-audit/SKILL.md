---
name: md-audit
version: 1.0.0
description: |
  Read-only code quality audit — scan the current working directory for common
  issues (bugs, dead code, security hotspots, missing error handling) and return
  a prioritised findings report. No files are edited.
  Use when asked to "audit the code", "quick audit", "find issues", "code scan",
  or "what's wrong with this codebase". (munder-difflin)
allowed-tools:
  - Read
  - Bash
  - Grep
---

## Code Audit (read-only)

Perform a read-only code quality scan and return a findings report. Do NOT edit any files.

Steps:
1. **Scope** — identify the primary language and entry points (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or similar).
2. **Scan** — use `Grep` and `Read` to look for:
   - Unhandled promise rejections / ignored errors
   - Hard-coded secrets or credentials (keys, tokens, passwords)
   - `TODO`/`FIXME`/`HACK` comments that signal known debt
   - Dead exports (exported symbols with no in-repo import)
   - Obvious type-safety gaps (unchecked `any`, missing null guards)
3. **Report**: output a findings list sorted by severity (Critical → High → Medium → Low).
   - An empty report is a valid result. If the scan turns up nothing real, say so; do not invent or inflate findings to fill a section.
   - Every finding names its fix: the `file:line` it sits on and the concrete change that resolves it, or a measurable change (a count, a threshold) when it spans files. A finding with neither is cut.
   Omit empty severity sections.
   ```
   ## Audit Report — <project name>

   ### Critical
   - [file:line] <description>. Fix: <change>

   ### High
   - ...

   ### Summary
   <total count> findings across <file count> files scanned. (0 findings is a valid summary.)
   ```
4. Stop after reporting. Do not apply any fixes.
