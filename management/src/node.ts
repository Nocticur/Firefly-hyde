import { serve } from "@hono/node-server";
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { localDatabase } from "./local-database.ts";
import { RecordStore } from "./store.ts";
import { importBaseline } from "./content.ts";
import { randomToken } from "./security.ts";
import { runMaintenance } from "./maintenance.ts";
import type { Bindings,Services } from "./types.ts";

if(process.env.ENVIRONMENT && process.env.ENVIRONMENT!=="development")throw new Error("Use a platform entry for production; the local Node entry is development-only");
const port=Number(process.env.PORT??"8787"),localDir=resolve(".local");
await mkdir(localDir,{recursive:true});
let key=process.env.DEV_AUTH_SECRET;
if(!key){try{key=(await readFile(resolve(localDir,"development-key"),"utf8")).trim();}catch{key=randomToken();await writeFile(resolve(localDir,"development-key"),key,{mode:0o600});}}
const env:Bindings={...process.env,ENVIRONMENT:"development",PLATFORM:"local",NODE_ENV:"development",DEV_AUTH_SECRET:key,ADMIN_ORIGIN:process.env.ADMIN_ORIGIN??`http://localhost:${port}`,BLOG_ORIGIN:process.env.BLOG_ORIGIN??"http://localhost:4321",MEDIA_ORIGIN:process.env.MEDIA_ORIGIN??`http://localhost:${port}/media/`,LOCAL_MEDIA_PATH:process.env.LOCAL_MEDIA_PATH??resolve(localDir,"media")};
const db=await localDatabase(process.env.LOCAL_DB_PATH??resolve(localDir,"management.sqlite"));const store=new RecordStore(db);await store.migrate();
const services:Services={store,env,fetcher:fetch,now:Date.now};
await importBaseline(services,JSON.parse(await readFile(resolve("baseline.json"),"utf8")));
const app=createApp(services);
const server=serve({fetch:app.fetch,hostname:"0.0.0.0",port});
const maintenanceTimer=setInterval(()=>{runMaintenance(services).catch(()=>{});},15_000);maintenanceTimer.unref();
console.log(`Management API listening on http://localhost:${port}; local login key is stored in .local/development-key (not printed)`);
const stop=()=>server.close(async()=>{clearInterval(maintenanceTimer);await db.close?.();process.exit(0);});process.on("SIGTERM",stop);process.on("SIGINT",stop);
