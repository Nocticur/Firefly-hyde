import type { Hono } from "hono";
import { z } from "zod";
import { ApiError,required } from "./errors.ts";
import { importBaseline } from "./content.ts";
import { sha256 } from "./security.ts";
import { getPrivateObject,listPrivateObjects,putPrivateObject,readLimited } from "./storage.ts";
import type { Change } from "./store.ts";
import type { AppEnv,Friend,MailAttempt,Media,Services,SiteLock,SqlStatement,Task } from "./types.ts";

type Outbox={id:string;friendId:string;type:string;recipient:string;reason:string;notificationKey:string;status:string;attempts:number;createdAt:string;updatedAt:string;firstAttemptAt?:number;nextRunAt?:number;providerId?:string;error?:string};
type Backup={schemaVersion:1;id:string;createdAt:string;records:Array<{kind:string;id:string;version:number;value:unknown;updatedAt:string}>;media:Awaited<ReturnType<typeof listPrivateObjects>>};
const ephemeral=new Set(["session","oauth-state","rate","lease","daily-backup","backup","maintenance-lock","publish-lock"]);
export async function createBackup(services:Services,id:string=crypto.randomUUID()):Promise<{id:string;key:string;sha256:string;recordCount:number;mediaCount:number}>{
  const existing=await services.store.get<{id:string;key:string;sha256:string;recordCount:number;mediaCount:number}>("backup",id);
  if(existing){await validatedBackup(services,id);return existing.value;}
  const createdAt=new Date(services.now()).toISOString();
  // One SQL transaction captures a consistent private record set. No injected
  // environment, credential binding or token value is copied into the backup.
  const result=await services.store.db.batch([{sql:"SELECT * FROM records ORDER BY kind,id"}]);
  const records=result[0].rows.filter(x=>!ephemeral.has(String(x.kind))).map(x=>({kind:String(x.kind),id:String(x.id),version:Number(x.version),value:JSON.parse(String(x.value)),updatedAt:String(x.updated_at)}));
  const media=(await listPrivateObjects(services)).filter(x=>!x.key.startsWith("backups/"));
  const backup:Backup={schemaVersion:1,id,createdAt,records,media};
  const bytes=new TextEncoder().encode(JSON.stringify(backup)),digest=await sha256(bytes.slice().buffer),key=`backups/${createdAt.slice(0,10)}/${id}.json`;
  await putPrivateObject(services,key,bytes,"application/json");
  // Read-after-write verification protects the saved backup from truncation.
  const verified=await getPrivateObject(services,key);
  if(!verified || await sha256((await readLimited(verified.body,64*1024*1024)).buffer as ArrayBuffer)!==digest)throw new ApiError(502,"BACKUP_VERIFY_FAILED","The private backup could not be verified");
  const metadata={id,key,sha256:digest,createdAt,recordCount:records.length,mediaCount:media.length};await services.store.create("backup",id,metadata);return metadata;
}
async function validatedBackup(services:Services,id:string):Promise<Backup>{
  const row=await services.store.get<{key:string;sha256:string}>("backup",id);if(!row)throw new ApiError(404,"BACKUP_NOT_FOUND","Backup not found");
  const object=await getPrivateObject(services,row.value.key);if(!object)throw new ApiError(404,"BACKUP_NOT_FOUND","Private backup object not found");
  const bytes=await readLimited(object.body,64*1024*1024);if(await sha256(bytes.slice().buffer)!==row.value.sha256)throw new ApiError(400,"BACKUP_CHECKSUM_FAILED","Backup checksum mismatch");
  const backup=JSON.parse(new TextDecoder().decode(bytes)) as Backup;
  if(backup.schemaVersion!==1 || !Array.isArray(backup.records)||!Array.isArray(backup.media))throw new ApiError(400,"BACKUP_INVALID","Unsupported backup schema");
  // Older backups may contain an obsolete publication lock. Locks are acquired
  // afresh from durable tasks; they are never restored over the active gate.
  backup.records=backup.records.filter(x=>x.kind!=="publish-lock");
  const keys=new Set<string>();for(const record of backup.records){if(ephemeral.has(record.kind)||!record.id||!Number.isInteger(record.version)||record.version<1||keys.has(`${record.kind}:${record.id}`))throw new ApiError(400,"BACKUP_INVALID","Backup records are invalid");keys.add(`${record.kind}:${record.id}`);}
  // The backup intentionally stores a media inventory, rather than transient
  // URLs. All referenced private objects must remain present before restoration.
  for(const entry of backup.media){const existing=await getPrivateObject(services,entry.key);if(!existing)throw new ApiError(409,"MEDIA_RESTORE_REQUIRED",`Restore missing private object ${entry.key} before restoring records`);}
  for(const record of backup.records.filter(x=>x.kind==="media")){
    const media=record.value as Media;if(media.status==="pending")continue;
    const object=await getPrivateObject(services,media.key);if(!object)throw new ApiError(409,"MEDIA_RESTORE_REQUIRED","A referenced private media object is missing");
    const data=await readLimited(object.body,10*1024*1024);
    if(data.byteLength!==media.size || !media.sha256 || await sha256(data.slice().buffer)!==media.sha256)throw new ApiError(409,"MEDIA_CHECKSUM_FAILED","A referenced private media object changed or is truncated");
  }
  return backup;
}
export async function verifyBackup(services:Services,id:string){const backup=await validatedBackup(services,id);return {valid:true,backupId:id,recordCount:backup.records.length,mediaCount:backup.media.length,mutated:false};}
export async function restoreBackup(services:Services,id:string,confirm:string,options:{task?:Task}={}){
  if(confirm!=="RESTORE_PRIVATE_DATA")throw new ApiError(400,"RESTORE_CONFIRM_REQUIRED","Review the backup and send confirm=RESTORE_PRIVATE_DATA");
  const backup=await validatedBackup(services,id);
  const owner=`restore:${id}:${crypto.randomUUID()}`,lease=await services.store.acquireLease("site-restore",owner,120_000);
  const gate:SiteLock={mode:"restore",restoreId:id,owner,leaseFence:lease.value.fence};let gateVersion:number|undefined;
  try{
    try{
      await services.store.atomic([{kind:"publish-lock",id:"site",expectedVersion:null,value:gate},{kind:"lease",id:"site-restore",expectedVersion:lease.version,checkOnly:true}]);gateVersion=1;
    }catch(error){if(error instanceof ApiError&&error.code==="VERSION_CONFLICT")throw new ApiError(409,"PUBLICATION_ACTIVE","Drain publication tasks before restoring private data");throw error;}
    // Keep a verified safety backup before replacing records. Historical backup
    // catalog entries remain available; session/state leases are invalidated.
    await createBackup(services);
    // Successful external mail receipts survive an older data restoration. A
    // restored pending outbox can therefore never send an already delivered
    // notification again after the provider's idempotency window has elapsed.
    const assertionId=crypto.randomUUID();
    const statements:SqlStatement[]=[{
      sql:"INSERT INTO transaction_assertions(id,ok) SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM records WHERE kind='publish-lock' AND id='site' AND version=? AND value=?) AND EXISTS(SELECT 1 FROM records WHERE kind='lease' AND id='site-restore' AND version=? AND value=?) THEN 1 ELSE 0 END",
      params:[assertionId,gateVersion,JSON.stringify(gate),lease.version,JSON.stringify(lease.value)],
    },{sql:"DELETE FROM records WHERE kind NOT IN ('backup','lease','daily-backup','notify-receipt','mail-attempt','publish-lock')"},...backup.records.map(record=>({sql:"INSERT INTO records(kind,id,version,value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO NOTHING",params:[record.kind,record.id,record.version,JSON.stringify(record.value),record.updatedAt]}))];
    if(options.task && !backup.records.some(x=>x.kind==="task" && x.id===options.task!.id)){
      const current=await services.store.get<Task>("task",options.task.id);
      statements.push({sql:"INSERT INTO records(kind,id,version,value,updated_at) VALUES(?,?,?,?,?)",params:["task",options.task.id,(current?.version??0)+1,JSON.stringify(options.task),new Date(services.now()).toISOString()]});
    }
    statements.push({sql:"DELETE FROM transaction_assertions WHERE id=?",params:[assertionId]});
    await services.store.assertLease("site-restore",owner,lease.value.fence);await services.store.db.batch(statements);
    await services.store.create("audit",crypto.randomUUID(),{type:"restore",backupId:id,createdAt:new Date(services.now()).toISOString()});
    return {restored:backup.records.length,mediaVerified:backup.media.length,sessionsRevoked:true};
  }finally{
    const current=await services.store.get<SiteLock>("publish-lock","site");
    if(current?.value.mode==="restore" && current.value.owner===owner && current.value.leaseFence===lease.value.fence)await services.store.atomic([{kind:"publish-lock",id:"site",expectedVersion:current.version,remove:true}]);
    await services.store.releaseLease("site-restore",owner,lease.value.fence);
  }
}
async function sendOutbox(services:Services,row:{id:string;version:number;value:Outbox}){
  const item=row.value;if(services.env.ENVIRONMENT!=="production")return;
  if(!["pending","unknown"].includes(item.status)||(item.nextRunAt??0)>services.now())return;
  if(item.type==="friend-approved" && !await services.store.get("public-friend",item.friendId))return;
  const receipt=await services.store.get<{providerId:string}>("notify-receipt",item.notificationKey);
  if(receipt){await services.store.update("outbox",row.id,row.version,{...item,status:"sent",providerId:receipt.value.providerId,error:undefined});return;}
  const apiKey=required(services.env.RESEND_API_KEY,"RESEND_API_KEY"),from=required(services.env.MAIL_FROM,"MAIL_FROM");
  const attempt=await services.store.get<MailAttempt>("mail-attempt",item.notificationKey);
  const firstAttemptAt=Math.min(...[attempt?.value.firstAttemptAt,item.firstAttemptAt].filter((x):x is number=>typeof x==="number"));
  if(Number.isFinite(firstAttemptAt)&&services.now()-firstAttemptAt>=23*60*60*1000){await services.store.update("outbox",row.id,row.version,{...item,status:"failed",firstAttemptAt,error:"Provider idempotency window expired; verify delivery before manual retry"});return;}
  const owner=`${row.id}:${crypto.randomUUID()}`,lease=await services.store.acquireLease(`mail-${row.id}`,owner,30_000);let latest=row;
  try{
    const started=Number.isFinite(firstAttemptAt)?firstAttemptAt:services.now();
    const claimed={...item,status:"unknown",attempts:item.attempts+1,firstAttemptAt:started,updatedAt:new Date(services.now()).toISOString()};
    const claimChanges:Change[]=[{kind:"outbox",id:row.id,expectedVersion:row.version,value:claimed},{kind:"lease",id:`mail-${row.id}`,expectedVersion:lease.version,checkOnly:true}];
    if(attempt)claimChanges.push({kind:"mail-attempt",id:item.notificationKey,expectedVersion:attempt.version,checkOnly:true});
    else claimChanges.push({kind:"mail-attempt",id:item.notificationKey,expectedVersion:null,value:{notificationKey:item.notificationKey,firstAttemptAt:started,createdAt:new Date(services.now()).toISOString()} satisfies MailAttempt});
    await services.store.atomic(claimChanges);latest=(await services.store.get<Outbox>("outbox",row.id))!;
    const response=await services.fetcher("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json","Idempotency-Key":item.notificationKey},body:JSON.stringify({from,to:[item.recipient],subject:item.type==="friend-approved"?"友链已在生产站点上线":"友链申请审核结果",text:item.type==="friend-approved"?`您的友链现已上线：${required(services.env.BLOG_ORIGIN,"BLOG_ORIGIN")}`:`友链申请未通过。原因：${item.reason}`}),signal:AbortSignal.timeout(15000),redirect:"error"});
    if(!response.ok)throw new Error(`Mail provider returned HTTP ${response.status}`);
    const result=await response.json() as {id:string};if(!result.id)throw new Error("Mail provider did not return an email ID");
    await services.store.assertLease(`mail-${row.id}`,owner,lease.value.fence);
    const friend=await services.store.get<Friend>("friend",item.friendId),changes:Change[]=[{kind:"outbox",id:row.id,expectedVersion:latest.version,value:{...latest.value,status:"sent",providerId:result.id,updatedAt:new Date(services.now()).toISOString()}}];
    changes.push({kind:"notify-receipt",id:item.notificationKey,expectedVersion:null,value:{notificationKey:item.notificationKey,providerId:result.id,deliveredAt:new Date(services.now()).toISOString()}});
    if(friend)changes.push({kind:"friend",id:friend.id,expectedVersion:friend.version,value:{...friend.value,notificationStatus:"sent"}});await services.store.atomic(changes);
  }catch(error){
    if(error instanceof ApiError && error.code==="VERSION_CONFLICT")throw error;
    const fresh=await services.store.get<Outbox>("outbox",row.id);if(fresh && fresh.value.status!=="sent")await services.store.update("outbox",row.id,fresh.version,{...fresh.value,status:"unknown",error:"Mail delivery is unconfirmed; retry uses the same provider idempotency key",nextRunAt:services.now()+60_000});
  }finally{await services.store.releaseLease(`mail-${row.id}`,owner,lease.value.fence);}
}
async function performTask(services:Services,task:Task):Promise<unknown>{
  switch(task.type){
    case "backup":return createBackup(services,task.id);
    case "restore":return restoreBackup(services,String(task.payload.backupId??""),String(task.payload.confirm??""),{task});
    case "verify-backup":return verifyBackup(services,String(task.payload.backupId??""));
    case "check-updates":{
      const repo=required(services.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY");
      const response=await services.fetcher(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{Accept:"application/vnd.github+json","User-Agent":"Nocticur-Management"},signal:AbortSignal.timeout(15000)});
      if(response.status===404)return {latestRelease:null,message:"Repository has no tagged release"};if(!response.ok)throw new ApiError(502,"UPDATE_CHECK_FAILED","GitHub release lookup failed");
      const release=await response.json() as {tag_name:string;html_url:string};return {latestRelease:release.tag_name,url:release.html_url,automaticUpgrade:false};
    }
    case "clear-cache":{
      // APIs, private previews and release manifests are always no-store. Only
      // platform public asset caches may be purged through their official API.
      const account=required(services.env.CLOUDFLARE_ACCOUNT_ID,"CLOUDFLARE_ACCOUNT_ID"),token=required(services.env.CLOUDFLARE_API_TOKEN,"CLOUDFLARE_API_TOKEN");
      const zone=required(services.env.CLOUDFLARE_ZONE_ID,"CLOUDFLARE_ZONE_ID");
      const response=await services.fetcher(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({purge_everything:true}),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new ApiError(502,"CACHE_PURGE_FAILED","Cloudflare cache purge failed");return {purged:true,accountConfigured:Boolean(account)};
    }
    case "rebuild-index":{
      const {freezePublication,processPublication}=await import("./publishing.ts");
      let id=task.payload.publicationId as string|undefined;
      if(!id){const publication=await freezePublication(services,{articleIds:[],expectedVersions:{}});id=publication.id;const current=await services.store.get<Task>("task",task.id);if(current)await services.store.update("task",task.id,current.version,{...current.value,payload:{...current.value.payload,publicationId:id}});}
      const publication=await processPublication(services,id);return {publicationId:id,status:publication.status,productionSha:publication.productionSha};
    }
    default:throw new ApiError(400,"TASK_TYPE_INVALID","Unsupported maintenance task");
  }
}
export async function runMaintenance(services:Services,options:{backup?:boolean}={}){
  const gate=await services.store.get<SiteLock>("publish-lock","site");
  if(gate?.value.mode==="restore"){
    const restoring=await services.store.get<{owner:string;expiresAt:number;fence:number}>("lease","site-restore");
    if(restoring && restoring.value.expiresAt>services.now())return;
    // A crashed restore must not leave a permanent gate. Fence its expired
    // execution and remove the gate atomically; its eventual replacement batch
    // asserts both versions and therefore cannot resume after this recovery.
    const changes:Change[]=[{kind:"publish-lock",id:"site",expectedVersion:gate.version,remove:true}];
    if(restoring)changes.push({kind:"lease",id:"site-restore",expectedVersion:restoring.version,value:{...restoring.value,expiresAt:0,fence:restoring.value.fence+1}});
    try{await services.store.atomic(changes);}catch(error){if(error instanceof ApiError&&error.status===409)return;throw error;}
  }
  if(options.backup){
    const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(services.now()));
    const marker=await services.store.get<{status:string}>("daily-backup",day);
    if(!marker || marker.value.status!=="succeeded"){
      const owner=`${day}:${crypto.randomUUID()}`,lease=await services.store.acquireLease(`daily-backup-${day}`,owner,120_000);
      try{const result=await createBackup(services);const fresh=await services.store.get("daily-backup",day);const value={status:"succeeded",backupId:result.id};if(fresh)await services.store.update("daily-backup",day,fresh.version,value);else await services.store.create("daily-backup",day,value);}finally{await services.store.releaseLease(`daily-backup-${day}`,owner,lease.value.fence);}
    }
  }
  for(const row of await services.store.all<Outbox>("outbox")){try{await sendOutbox(services,row);}catch(error){if(!(error instanceof ApiError&&error.code==="LEASE_BUSY"))throw error;}}
  for(const row of await services.store.all<Task>("task")){
    if(!["backup","restore","verify-backup","check-updates","rebuild-index","clear-cache"].includes(row.value.type)||!["pending","running","unknown"].includes(row.value.status)||(row.value.nextRunAt??0)>services.now())continue;
    const owner=`${row.id}:${crypto.randomUUID()}`;let lease;try{lease=await services.store.acquireLease(`maintenance-${row.id}`,owner,120_000);}catch(error){if(error instanceof ApiError&&error.code==="LEASE_BUSY")continue;throw error;}
    try{
      const running=await services.store.update<Task>("task",row.id,row.version,{...row.value,status:"running",attempts:row.value.attempts+1,updatedAt:new Date(services.now()).toISOString()});
      const result=await performTask(services,running.value);const latest=await services.store.get<Task>("task",row.id);
      if(latest){
        await services.store.assertLease(`maintenance-${row.id}`,owner,lease.value.fence);
        const publicationState=row.value.type==="rebuild-index"?(result as {status:string}).status:undefined;
        const status:Task["status"]=publicationState && !["succeeded","failed","conflict"].includes(publicationState)?"pending":publicationState && publicationState!=="succeeded"?"failed":"succeeded";
        await services.store.update("task",row.id,latest.version,{...latest.value,status,payload:{...latest.value.payload,result},...(status==="pending"?{nextRunAt:services.now()+60_000}:{}),updatedAt:new Date(services.now()).toISOString()});
      }
    }catch(error){const latest=await services.store.get<Task>("task",row.id);if(latest)await services.store.update("task",row.id,latest.version,{...latest.value,status:"failed",error:error instanceof ApiError?error.message:"Maintenance operation failed",updatedAt:new Date(services.now()).toISOString()});}
    finally{await services.store.releaseLease(`maintenance-${row.id}`,owner,lease.value.fence);}
  }
  // Remove expired transient records without exposing visitor identities.
  for(const kind of ["oauth-state","session","rate"]){for(const row of await services.store.all<{expiresAt:number}>(kind))if(row.value.expiresAt<services.now())try{await services.store.atomic([{kind,id:row.id,expectedVersion:row.version,remove:true}]);}catch(error){if(!(error instanceof ApiError&&error.status===409))throw error;}}
}
export function registerMaintenance(app:Hono<AppEnv>){
  app.post("/api/maintenance/import-baseline",async c=>{
    const services=c.get("services");
    const baseline=z.object({schemaVersion:z.literal(1),repository:z.string(),branch:z.string(),articles:z.array(z.object({id:z.string().uuid(),path:z.string(),slug:z.string(),raw:z.string().max(2_000_000),draft:z.boolean().optional(),title:z.string().optional()})).max(100),settings:z.record(z.string(),z.unknown()).optional(),navigation:z.array(z.any()).optional()}).parse(await c.req.json());
    if(baseline.repository!==required(services.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY") || baseline.branch!==(services.env.GITHUB_BRANCH??"main"))throw new ApiError(400,"BASELINE_TARGET_MISMATCH","Import the baseline for the configured repository and branch");
    return c.json(await importBaseline(services,baseline));
  });
  app.get("/api/maintenance/tasks",async c=>c.json({items:(await c.get("services").store.all<Task>("task")).map(x=>({...x.value,version:x.version}))}));
  app.get("/api/maintenance/backups",async c=>c.json({items:(await c.get("services").store.all("backup")).map(x=>({...x.value as object,version:x.version}))}));
  app.get("/api/maintenance/outbox",async c=>c.json({items:(await c.get("services").store.all("outbox")).map(x=>({...x.value as object,version:x.version}))}));
  app.post("/api/maintenance/tasks",async c=>{
    const input=z.object({type:z.enum(["backup","restore","verify-backup","check-updates","rebuild-index","clear-cache"]),payload:z.record(z.string(),z.unknown()).default({})}).parse(await c.req.json()),services=c.get("services"),now=new Date(services.now()).toISOString();
    if(["restore","verify-backup"].includes(input.type) && (typeof input.payload.backupId!=="string"||!input.payload.backupId))throw new ApiError(400,"BACKUP_REQUIRED","Select a verified private backup");
    if(input.type==="restore" && input.payload.confirm!=="RESTORE_PRIVATE_DATA")throw new ApiError(400,"RESTORE_CONFIRM_REQUIRED","Review the backup and send confirm=RESTORE_PRIVATE_DATA");
    const task:Task={id:crypto.randomUUID(),type:input.type,status:"pending",payload:input.payload,createdAt:now,updatedAt:now,attempts:0};await services.store.create("task",task.id,task);
    try{await dispatchMaintenance(services,task.id);}catch{const row=await services.store.get<Task>("task",task.id);if(row)await services.store.update("task",task.id,row.version,{...row.value,error:"Wake-up transport is unavailable; the durable task remains queued"});}return c.json({...task,version:1},202);
  });
  app.post("/api/maintenance/tasks/:id/retry",async c=>{
    const input=z.object({version:z.number().int().positive()}).parse(await c.req.json()),services=c.get("services"),row=await services.store.get<Task>("task",c.req.param("id"));if(!row)throw new ApiError(404,"TASK_NOT_FOUND","Task not found");if(!["failed","unknown"].includes(row.value.status))throw new ApiError(409,"TASK_NOT_RETRYABLE","Only failed or unconfirmed tasks can be retried");
    if(row.value.publicationId)throw new ApiError(409,"RECONCILE_REQUIRED","Reconcile this publication before retrying a commit");const next=await services.store.update("task",row.id,input.version,{...row.value,status:"pending",error:undefined,nextRunAt:services.now()});if(services.env.TASKS)await services.env.TASKS.send({taskId:row.id,type:"maintenance"});return c.json({...next.value,version:next.version},202);
  });
}
async function dispatchMaintenance(services:Services,id:string){
  if(services.env.TASKS)return services.env.TASKS.send({taskId:id,type:"maintenance"});
  if(services.env.ENVIRONMENT==="production")throw new ApiError(503,"CONFIG_REQUIRED","TASKS queue binding is required for maintenance wake-up delivery");
}
