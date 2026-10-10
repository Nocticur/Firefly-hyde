import { ApiError } from "./errors.ts";
import type { Database, SqlStatement, Stored } from "./types.ts";

export type Change = { kind: string; id: string; expectedVersion: number | null; value?: unknown; remove?: boolean; checkOnly?: boolean };
export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id))",
  "CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind,updated_at)",
  "CREATE TABLE IF NOT EXISTS transaction_assertions (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok = 1))",
];
export class RecordStore {
  constructor(public db: Database, public clock: () => number = Date.now) {}
  async migrate() { await this.db.batch(SCHEMA.map(sql => ({ sql }))); }
  private decode<T>(row: Record<string, unknown>): Stored<T> { return { id: String(row.id), version: Number(row.version), value: JSON.parse(String(row.value)), updatedAt: String(row.updated_at) }; }
  async get<T>(kind: string, id: string): Promise<Stored<T> | null> {
    const result = await this.db.query({ sql: "SELECT * FROM records WHERE kind=? AND id=?", params: [kind,id] });
    return result.rows[0] ? this.decode<T>(result.rows[0]) : null;
  }
  async all<T>(kind: string): Promise<Stored<T>[]> {
    const result = await this.db.query({ sql: "SELECT * FROM records WHERE kind=? ORDER BY updated_at DESC,id", params: [kind] });
    return result.rows.map(row => this.decode<T>(row));
  }
  async kinds(): Promise<string[]> { return (await this.db.query({ sql: "SELECT DISTINCT kind FROM records ORDER BY kind" })).rows.map(x => String(x.kind)); }
  async create<T>(kind: string, id: string, value: T): Promise<Stored<T>> { await this.atomic([{kind,id,value,expectedVersion:null}]); return (await this.get<T>(kind,id))!; }
  async update<T>(kind: string, id: string, expectedVersion: number, value: T): Promise<Stored<T>> { await this.atomic([{kind,id,value,expectedVersion}]); return (await this.get<T>(kind,id))!; }
  async atomic(changes: Change[]): Promise<void> {
    if (!changes.length) return;
    if (new Set(changes.map(x => `${x.kind}:${x.id}`)).size !== changes.length) throw new Error("Duplicate mutation key");
    const statements: SqlStatement[] = [];
    const now = new Date(this.clock()).toISOString();
    const assertionId = crypto.randomUUID();
    // Group guards and writes to stay under D1's 100-parameter SQL limit and
    // the free Worker's query budget, including the 16-record first import.
    // All guards run before any mutation within the same atomic D1 batch.
    for(let offset=0;offset<changes.length;offset+=25){
      const group=changes.slice(offset,offset+25),params:unknown[]=[`${assertionId}:${offset}`];
      const conditions=group.map(change=>{params.push(change.kind,change.id);if(change.expectedVersion===null)return "NOT EXISTS(SELECT 1 FROM records WHERE kind=? AND id=?)";params.push(change.expectedVersion);return "EXISTS(SELECT 1 FROM records WHERE kind=? AND id=? AND version=?)";});
      statements.push({sql:`INSERT INTO transaction_assertions(id,ok) SELECT ?, CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END`,params});
    }
    const writes=changes.filter(x=>!x.remove&&!x.checkOnly),removes=changes.filter(x=>x.remove&&!x.checkOnly);
    for(let offset=0;offset<writes.length;offset+=16){
      const group=writes.slice(offset,offset+16);
      statements.push({sql:`INSERT INTO records(kind,id,version,value,updated_at) VALUES ${group.map(()=>"(?,?,?,?,?)").join(",")} ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,value=excluded.value,updated_at=excluded.updated_at`,params:group.flatMap(change=>[change.kind,change.id,(change.expectedVersion??0)+1,JSON.stringify(change.value),now])});
    }
    for(let offset=0;offset<removes.length;offset+=40){const group=removes.slice(offset,offset+40);statements.push({sql:`DELETE FROM records WHERE ${group.map(()=>"(kind=? AND id=?)").join(" OR ")}`,params:group.flatMap(change=>[change.kind,change.id])});}
    statements.push({sql:"DELETE FROM transaction_assertions WHERE id LIKE ?",params:[`${assertionId}:%`]});
    try { await this.db.batch(statements); }
    catch (error) {
      if (/constraint|transaction_assertions|duplicate key|23505|23514/i.test(String(error))) {
        const current = await this.get(changes[0].kind,changes[0].id);
        throw new ApiError(409,"VERSION_CONFLICT","The record changed; reload before saving",{current:current ? {...(current.value as object),version:current.version} : null});
      }
      throw error;
    }
  }
  async acquireLease(key: string, owner: string, ttlMs: number) {
    const current = await this.get<{owner:string;expiresAt:number;fence:number}>("lease",key);
    if (current && current.value.expiresAt > this.clock()) throw new ApiError(409,"LEASE_BUSY","Another durable task owns this lease");
    const value = {owner,expiresAt:this.clock()+ttlMs,fence:(current?.value.fence ?? 0)+1};
    return current ? this.update("lease",key,current.version,value) : this.create("lease",key,value);
  }
  async releaseLease(key: string, owner: string, fence: number) {
    const lease = await this.get<{owner:string;expiresAt:number;fence:number}>("lease",key);
    if (lease && lease.value.owner === owner && lease.value.fence === fence) await this.update("lease",key,lease.version,{...lease.value,expiresAt:0});
  }
  async assertLease(key: string, owner: string, fence: number) {
    const lease = await this.get<{owner:string;expiresAt:number;fence:number}>("lease",key);
    if (!lease || lease.value.owner !== owner || lease.value.fence !== fence || lease.value.expiresAt <= this.clock()) throw new ApiError(409,"LEASE_EXPIRED","Task lease has been fenced out");
    return lease;
  }
}
