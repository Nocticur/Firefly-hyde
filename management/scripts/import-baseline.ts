import { readFile } from "node:fs/promises";
import { required } from "../src/errors.ts";
const origin=required(process.env.ADMIN_ORIGIN,"ADMIN_ORIGIN"),cookie=required(process.env.MANAGEMENT_SESSION_COOKIE,"MANAGEMENT_SESSION_COOKIE"),csrf=required(process.env.MANAGEMENT_CSRF_TOKEN,"MANAGEMENT_CSRF_TOKEN");
const response=await fetch(new URL("/api/maintenance/import-baseline",origin),{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrf,Origin:new URL(origin).origin,"Content-Type":"application/json"},body:await readFile(new URL("../baseline.json",import.meta.url),"utf8"),signal:AbortSignal.timeout(60_000),redirect:"error"});
const result=await response.json();if(!response.ok)throw new Error(`Baseline import rejected: HTTP ${response.status}`);console.log(JSON.stringify(result));
