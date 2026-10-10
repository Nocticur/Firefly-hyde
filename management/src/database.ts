import type { Database, SqlStatement, SqlResult } from "./types.ts";

type D1 = { prepare(sql:string): {bind(...params:unknown[]):any}; batch(statements:any[]):Promise<any[]> };
export function d1Database(db: D1): Database {
  const prepare = (s:SqlStatement) => db.prepare(s.sql).bind(...(s.params ?? []));
  const decode = (r:any):SqlResult => ({rows:r.results ?? [],changes:r.meta?.changes ?? 0});
  return {query:async s=>decode(await prepare(s).all()),batch:async ss=>(await db.batch(ss.map(prepare))).map(decode)};
}
