import Database from 'better-sqlite3';
import { agyConversationDb } from './agyUsage';
import { refusalFromStep, type ModelRefusal } from './agyRefusals';

/** A bounded, read-only fallback for refusals missed by the terminal observer. */
export function readAgyRefusals(agentId: string, sessionId: string | undefined, now: number): ModelRefusal[] {
  const path = sessionId ? agyConversationDb(sessionId) : null;
  if (!path) return [];
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 100 });
    const rows = db.prepare('SELECT metadata, step_payload FROM steps WHERE step_type = 17 ORDER BY idx DESC LIMIT 32').all() as Array<{ metadata: Buffer; step_payload: Buffer }>;
    return rows.flatMap((r) => {
      const hit = refusalFromStep(agentId, r.metadata, r.step_payload, now);
      return hit ? [hit] : [];
    }).reverse();
  } catch { return []; }
  finally { db?.close(); }
}
