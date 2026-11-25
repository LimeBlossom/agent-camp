import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStartTemplateLoader } from '../shared/dormantWake';

/** Standard keys for harness-authored message templates. */
export type MessageTemplateKey =
  | 'drainForStop'
  | 'workerReapedTokenCap'
  | 'workerReapedIdle'
  | 'workerWorktreeReclaimed'
  | 'unityPrompt'
  | 'startPrompt';

/** Canonical bundled fallbacks for harness-authored message bodies. */
export const BUNDLED_MESSAGE_TEMPLATES: Readonly<Record<Exclude<MessageTemplateKey, 'startPrompt'>, string>> = Object.freeze({
  drainForStop:
    'You have {{count}} new hive message(s) in your inbox. Address them before finishing:\n' +
    '{{lines}}\n' +
    'Open the files in {{inboxDir}} for full detail, act on each, then move handled ones to {{doneDir}}. Reply via your outbox if a message requires it.',

  workerReapedTokenCap:
    'Worker {{workerId}} used {{used}} tokens (> its cap of {{tokenCap}}) and was reaped. Any committed work on its branch is preserved for you.',

  workerReapedIdle:
    'Worker {{workerId}} produced no output for {{idleMinutes}} min (> the {{capMinutes}} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.',

  workerWorktreeReclaimed:
    'The preserved worktree for {{workerId}} is now integrated ({{detail}}), so it and its scratch dir were garbage-collected.\nWorktree: {{wtPath}}',

  unityPrompt:
    'UNITY (batch only): you cannot run Unity yourself; the harness runs it for you in batch mode with the GPU, never a window. ' +
    'Write ONE JSON file to {{requestsFile}}: {"project": "<Unity project inside your folder or extra folders>", ' +
    '"executeMethod": "Namespace.Class.Method", "args": [], "env": {}, "timeoutSec": 600}. Only "project" is required. ' +
    '"args" may hold only -runTests, -testPlatform <v>, -testFilter <v>, -testCategory <v>, -assemblyNames <v>, ' +
    '-testResults [<file name>], -buildTarget <v>, -nographics, -quit; the harness adds -batchmode, -projectPath, ' +
    '-logFile and -force-vulkan (Unity runs on a private hidden display, where only Vulkan reaches the GPU), ' +
    'and anything else rejects the request. Pass -quit with executeMethod unless your method exits Unity itself ' +
    '(never with -runTests), or the run sits until timeoutSec (default 600, max 3600). "env" keys are UPPER_CASE; ' +
    'LD_*, PATH, HOME, DISPLAY, XAUTHORITY, UNITY_* and BWRAP* are refused. One run per project at a time, ' +
    'at most 2 agent runs at once and one start per agent every 5 minutes (extra requests wait in the queue), so batch ' +
    'all tests for a change into one run and never rerun a passing result; ' +
    'and a project already open in another Unity is refused, as is a Library hardlinked to another tree: ' +
    'seed a worktree Library with cp -a --reflink=auto, never cp -al. When it ends you get an inbox message; results are in ' +
    '{{resultsFile}}: result.json {ok, exitCode, reason, durationSec, logPath, outputs}, unity.log, and whatever ' +
    'your method wrote to the folder named by the MD_UNITY_OUT environment variable. Outside the project and that ' +
    "folder, writes are refused. Each run gets its own copy of the game's PlayerPrefs, seeded from the user's and " +
    'discarded after, so runs never share settings and need no save window. Screenshots: ScreenCapture returns null ' +
    'in batch mode, so a capture method must call PlayModeWindow.SetCustomRenderingResolution before ' +
    'EditorApplication.EnterPlaymode, switch root Screen Space - Overlay canvases to Screen Space - Camera for ' +
    'the shot, then render a Camera into a RenderTexture and ReadPixels it.'
});

type TemplateValues = Record<string, string | number | undefined | null>;

/** Fill `{{key}}` placeholders; a placeholder with no value is left as written. */
export function interpolateTemplate(template: string, values: TemplateValues = {}): string {
  return template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (match, param: string) => {
    const val = values[param];
    return val !== undefined && val !== null ? String(val) : match;
  });
}

/**
 * Read <hiveRoot>/prompts/messages/<key>.md afresh and fill it. Null (so the caller uses its built-in
 * text) when the root is unset, the key is unsafe, the file is missing, unreadable or blank, or it
 * names a placeholder this message has no value for.
 */
export function loadMessageTemplate(hiveRoot: string | null | undefined, key: string, values: TemplateValues = {}): string | null {
  if (!hiveRoot || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return null;
  try {
    const raw = readFileSync(join(hiveRoot, 'prompts', 'messages', `${key}.md`), 'utf8');
    if (!raw.trim()) return null;
    for (const m of raw.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g)) {
      if (values[m[1]] === undefined || values[m[1]] === null) return null;
    }
    return interpolateTemplate(raw, values);
  } catch {
    return null;
  }
}

/** The template override when present and valid, else `fallback` (text with placeholders, or a builder). */
export function renderMessageTemplate(
  hiveRoot: string | null | undefined,
  key: string,
  values: TemplateValues,
  fallback: string | ((v: TemplateValues) => string)
): string {
  const loaded = loadMessageTemplate(hiveRoot, key, values);
  if (loaded !== null) return loaded;
  return typeof fallback === 'function' ? fallback(values) : interpolateTemplate(fallback, values);
}

setStartTemplateLoader(loadMessageTemplate);
