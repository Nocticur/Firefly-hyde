import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Database, SqlStatement, SqlResult } from "./types.ts";

export async function localDatabase(path: string): Promise<Database> {
  if(path!==":memory:") await mkdir(dirname(path),{recursive:true});
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  const run = (s:SqlStatement):SqlResult => {
    const statement = db.prepare(s.sql); const params=(s.params ?? []) as Array<string|number|null>;
    if (/^\s*(SELECT|WITH)/i.test(s.sql)) return {rows:statement.all(...params) as Record<string,unknown>[],changes:0};
    const result=statement.run(...params); return {rows:[],changes:Number(result.changes)};
  };
  return {query:async s=>run(s),batch:async statements=> {
    db.exec("BEGIN IMMEDIATE"); try { const out=statements.map(run); db.exec("COMMIT"); return out; } catch(e){db.exec("ROLLBACK");throw e;}
  },close:async()=>db.close()};
}
