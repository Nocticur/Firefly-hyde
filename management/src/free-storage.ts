import { Buffer } from "node:buffer";
import { ApiError } from "./errors.ts";
import type { Services } from "./types.ts";

export const FREE_MEDIA_LIMIT = 256 * 1024;
export const FREE_BACKUP_LIMIT = 1024 * 1024;
export const FREE_STORAGE_LIMIT = 20 * 1024 * 1024;
export const FREE_OBJECT_SCHEMA = "CREATE TABLE IF NOT EXISTS free_objects (visibility TEXT NOT NULL CHECK(visibility IN ('private','public')), key TEXT NOT NULL, data TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), PRIMARY KEY(visibility,key))";
type Visibility = "private" | "public";

export async function freePut(services:Services,visibility:Visibility,key:string,bytes:Uint8Array,contentType:string,overwrite:boolean):Promise<void>{
	const limit=key.startsWith("backups/") && visibility === "private" ? FREE_BACKUP_LIMIT : FREE_MEDIA_LIMIT;
	if(bytes.byteLength>limit)throw new ApiError(413,"FREE_STORAGE_LIMIT",`免费存储单张图片不超过 256 KiB，单份备份不超过 1 MiB。当前文件超出 ${limit} 字节限制。`);
	const existing=await services.store.db.query({sql:"SELECT size FROM free_objects WHERE visibility=? AND key=?",params:[visibility,key]});
	if(existing.rows.length && !overwrite)throw new ApiError(409,"OBJECT_EXISTS","The immutable object already exists");
	// Quota check and write are one statement, so concurrent uploads cannot exceed the cap.
	const sql="INSERT INTO free_objects(visibility,key,data,content_type,size) SELECT ?,?,?,?,? WHERE (SELECT COALESCE(SUM(size),0) FROM free_objects)-(SELECT COALESCE((SELECT size FROM free_objects WHERE visibility=? AND key=?),0))+?<=?" + (overwrite ? " ON CONFLICT(visibility,key) DO UPDATE SET data=excluded.data,content_type=excluded.content_type,size=excluded.size" : "");
	try{
		const result=await services.store.db.query({sql,params:[visibility,key,Buffer.from(bytes).toString("base64"),contentType,bytes.byteLength,visibility,key,bytes.byteLength,FREE_STORAGE_LIMIT]});
		if(!result.changes)throw new ApiError(413,"FREE_STORAGE_FULL","免费媒体与备份空间已达到 20 MiB，请先下载并清理旧备份。");
	}catch(error){
		if(/UNIQUE constraint/i.test(String(error)))throw new ApiError(409,"OBJECT_EXISTS","The immutable object already exists");
		throw error;
	}
}
export async function freeGet(services:Services,visibility:Visibility,key:string){
	const result=await services.store.db.query({sql:"SELECT data,content_type,size FROM free_objects WHERE visibility=? AND key=?",params:[visibility,key]});
	const row=result.rows[0];if(!row)return null;
	const bytes=new Uint8Array(Buffer.from(String(row.data),"base64"));
	return {key,provider:"d1" as const,size:Number(row.size),contentType:String(row.content_type),body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}})};
}
export async function freeDelete(services:Services,key:string){
	await services.store.db.query({sql:"DELETE FROM free_objects WHERE visibility='private' AND key=?",params:[key]});
}
export async function freeList(services:Services,prefix:string){
	const result=await services.store.db.query({sql:"SELECT key,size,content_type FROM free_objects WHERE visibility='private' AND substr(key,1,?)=? ORDER BY key",params:[prefix.length,prefix]});
	return result.rows.map(row=>({key:String(row.key),size:Number(row.size),contentType:String(row.content_type),provider:"d1" as const}));
}
