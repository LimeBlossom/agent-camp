/** The ~/.claude/hooks/agy-guard.sh rules for jailed agents, whose shell calls (Antigravity's
 *  run_command included) never reach that Claude Code Bash hook. Keep the two in step:
 *  the case table in test/jail-agy-guard.test.cjs mirrors hooks/agy-guard.test.py. */

const RAW_PRINT = /(^|[;&|(])\s*agy\s+[^;|&\n]*(-p\s|--print|--prompt)/m;
const PRO_MODEL = /(^|[;&|(])\s*agy(-ask)?\s+[^;|&\n]*--model\s+[^;|&\n]*gemini-3\.1-pro/m;

const RAW_PRINT_REASON = "Use agy-ask, not raw 'agy -p'. Raw print mode returns status SUCCESS with an EMPTY response when a tool is soft-denied, so a failed call looks like a successful one. ~/.local/bin/agy-ask fences the prompt to read_url, forces JSON, exits 3 on the empty-success trap, flags truncation, and logs context cost to ~/.local/share/agy-ask/usage.log. Run: agy-ask 'your prompt' [--model M] [--allow-shell]. See memory reference_agy_fetch_delegate.";
const PRO_MODEL_REASON = 'Do not select gemini-3.1-pro on agy. Verified 2026-09-08: it returned 6 YouTube video IDs of which 5 were HTTP 404, attaching REAL titles and view counts to invented IDs and labelling every row VERIFIED. 3.1-pro is an older generation than 3.8-flash, not a stronger one. Omit --model to get the 3.8 Flash default, which got the same task right. See memory feedback_gemini_fabricates_identifiers.';

/** The deny reason for a shell command line, or null when it may run. */
export function agyGuardDeny(command: string): string | null {
  if (!command.includes('agy')) return null;
  if (RAW_PRINT.test(command)) return RAW_PRINT_REASON;
  if (PRO_MODEL.test(command)) return PRO_MODEL_REASON;
  return null;
}
