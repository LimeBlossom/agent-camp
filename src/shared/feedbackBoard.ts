import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Feedback board: parses F8 feedback reports from hive/feedback/<game>/<msg-id>/,
 * handles dismissing reports, and creating kanban cards for agents.
 */

export interface FeedbackReport {
  id: string;
  game: string;
  title: string;
  text: string;
  scene?: string;
  run?: string;
  seed?: string;
  version?: string;
  time?: string;
  screenshotPath?: string;
  logPath?: string;
  /** the human's thoughts or instructions saved with the report. */
  note?: string;
  /** The report's folder on disk. */
  dir?: string;
  handled?: boolean;
  dismissed?: boolean;
}

export interface FeedbackCardPayload {
  title: string;
  project: string;
  assignee: string;
  status: 'todo';
  description: string;
  notes?: string;
  reportId?: string;
  reportFolder?: string;
}

const HANDLED_MARKER = '.handled';
const NOTE_FILE = 'note.txt';
const META_LINE = /^-\s+\*\*([^*:]+?):?\*\*:?\s*(.*)$/;

/** Parses the report.md the puller writes: an H1 title, optional free text, a
 *  `- **Key**: value` metadata list, and an Attachments list. The description is
 *  either a "## Description" section or the text between the title and the metadata. */
export function parseReportMarkdown(rawMarkdown: string, msgId: string, game = 'Alpha'): FeedbackReport {
  const meta: Record<string, string> = {};
  const loose: string[] = [];
  const described: string[] = [];
  let title = '';
  let section = '';
  for (const line of rawMarkdown.replace(/\r/g, '').split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1].length === 1 && !title) title = h[2].trim();
      else section = h[2].trim().toLowerCase();
      continue;
    }
    const m = META_LINE.exec(line);
    if (m && section === '') { meta[m[1].trim().toLowerCase()] = m[2].trim(); continue; }
    if (section === 'description') described.push(line);
    else if (section === '' && !m) loose.push(line);
  }
  const text = (described.length ? described : loose).join('\n').trim();
  return {
    id: msgId, game, title, text,
    scene: meta.scene, run: meta.run, seed: meta.seed, version: meta.version, time: meta.timestamp,
    handled: false
  };
}

/** Unhandled reports under `<feedbackRoot>/<game>/<msg-id>/`, newest first. */
export function listFeedbackReports(feedbackRoot: string): FeedbackReport[] {
  const out: FeedbackReport[] = [];
  let games: string[];
  try { games = fs.readdirSync(feedbackRoot); } catch { return out; }
  for (const game of games) {
    const gameDir = path.join(feedbackRoot, game);
    let ids: string[];
    try { ids = fs.readdirSync(gameDir); } catch { continue; }
    for (const id of ids) {
      const dir = path.join(gameDir, id);
      try {
        if (fs.existsSync(path.join(dir, HANDLED_MARKER))) continue;
        const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
        const r = parseReportMarkdown(md, id, game.toUpperCase());
        r.dir = dir;
        const shot = path.join(dir, 'screenshot.png');
        const log = path.join(dir, 'recent.log');
        try { const n = fs.readFileSync(path.join(dir, NOTE_FILE), 'utf8'); if (n.trim()) r.note = n; } catch { /* no note yet */ }
        if (fs.existsSync(shot)) r.screenshotPath = shot;
        if (fs.existsSync(log)) r.logPath = log;
        out.push(r);
      } catch { /* not a report folder */ }
    }
  }
  return out.sort((a, b) => Date.parse(b.time ?? '') - Date.parse(a.time ?? '') || 0);
}

/** Marks a report folder handled so it leaves the board; false if it cannot be written. */
export function dismissFeedbackReport(reportDir: string, note: Record<string, unknown> = {}): boolean {
  try {
    fs.writeFileSync(path.join(reportDir, HANDLED_MARKER), JSON.stringify({ handledAt: new Date().toISOString(), ...note }), 'utf8');
    return true;
  } catch { return false; }
}

/** Saves the human's thoughts/actions with the report folder so it survives a reload. */
export function saveFeedbackNote(reportDir: string, note: string): boolean {
  try {
    fs.writeFileSync(path.join(reportDir, NOTE_FILE), note, 'utf8');
    return true;
  } catch { return false; }
}

/** The kanban card for a report. The description cites the report folder so the
 *  assignee can open the screenshot and log; an empty assignee leaves it for the Boss.
 *  the human's thoughts or instructions (humanNote) are placed under a 'The human says:' line. */
export function createFeedbackCardPayload(report: FeedbackReport, assignee: string, humanNote?: string): FeedbackCardPayload {
  const folder = report.dir ?? report.screenshotPath ?? report.logPath;
  const reportFolder = folder ? (report.dir ? folder : path.dirname(folder)).replace(/\\/g, '/') : `hive/feedback/${report.game.toLowerCase()}/${report.id}`;
  const facts = [
    report.version && `version ${report.version}`,
    report.scene && `scene ${report.scene}`,
    report.run && `run ${report.run}`,
    report.seed && `seed ${report.seed}`,
    report.time && `reported ${report.time}`
  ].filter(Boolean).join(', ');
  return {
    title: `${report.game} feedback: ${report.title || report.id}`,
    project: report.game,
    assignee,
    status: 'todo',
    description: [
      humanNote?.trim() && `The human says:\n${humanNote.trim()}`,
      report.text,
      facts && `(${facts})`,
      `Report folder: ${reportFolder} (report.md${report.screenshotPath ? ', screenshot.png' : ''}${report.logPath ? ', recent.log' : ''})`
    ].filter(Boolean).join('\n\n'),
    reportId: report.id,
    reportFolder
  };
}
