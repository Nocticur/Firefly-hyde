import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { localDatabase } from "../src/local-database.ts";
import { RecordStore } from "../src/store.ts";
import { putPrivateObject,putPublicObject,getPrivateObject,getPublicObject,readLimited } from "../src/storage.ts";
import { FREE_MEDIA_LIMIT,FREE_STORAGE_LIMIT } from "../src/free-storage.ts";
import { createBackup,runMaintenance } from "../src/maintenance.ts";
import { productionRequirements } from "../src/runtime.ts";
import { githubClient,dispatchPublicationTask } from "../src/integrations.ts";
import { sha256 } from "../src/security.ts";
import type { Services } from "../src/types.ts";

const origin="https://blog.example.test",password="test-password-only-2026";
async function fixture(){
	const db=await localDatabase(":memory:");
	let now=Date.parse("2026-10-11T06:00:00Z");
	const store=new RecordStore(db,()=>now);await store.migrate();
	const services:Services={store,now:()=>now,fetcher:fetch,env:{ENVIRONMENT:"production",PLATFORM:"cloudflare",FREE_PLAN:"1",MAIL_MODE:"disabled",AUTH_MODE:"password",ADMIN_PASSWORD:password,ADMIN_GITHUB_USER_ID:"285582250",IP_HASH_SECRET:"test-private-hash-key-2026",ADMIN_ORIGIN:origin,BLOG_ORIGIN:origin,MEDIA_ORIGIN:`${origin}/api/public/media/`,GITHUB_REPOSITORY:"example/blog",GITHUB_BRANCH:"main"}};
	const app=createApp(services);
	const request=(path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>app.request(`${origin}${path}`,{method,headers:{Origin:origin,"Content-Type":"application/json",...headers},...(body===undefined ? {} : {body:JSON.stringify(body)})});
	const login=()=>request("/api/auth/password","POST",{password});
	return {services,request,app,login,advance:(ms:number)=>now+=ms,close:()=>db.close?.()};
}

test("password login protects data, issues secure cookies and preserves CSRF/logout",async t=>{
	const f=await fixture();t.after(f.close);
	assert.equal((await f.request("/api/articles")).status,401);
	const wrong=await f.request("/api/auth/password","POST",{password:"incorrect-password"});assert.equal(wrong.status,401);assert.equal(wrong.headers.get("set-cookie"),null);
	const login=await f.login();assert.equal(login.status,200);
	const cookie=login.headers.get("set-cookie")!;for(const part of ["__Host-mgmt-session=","HttpOnly","Secure","SameSite=Lax","Path=/"])assert.ok(cookie.includes(part),part);
	const result=await login.json() as {user:{id:number};csrf:string};assert.equal(result.user.id,285582250);assert.ok(result.csrf);assert.ok(!JSON.stringify(result).includes(password));
	const headers={Cookie:cookie.split(";")[0]};assert.equal((await f.request("/api/me","GET",undefined,headers)).status,200);
	assert.equal((await f.request("/api/auth/logout","POST",{},headers)).status,403);
	assert.equal((await f.request("/api/auth/logout","POST",{},{...headers,"X-CSRF-Token":result.csrf})).status,200);
	assert.equal((await f.request("/api/me","GET",undefined,headers)).status,401);
});
test("password rotation and expiry invalidate existing sessions",async t=>{
	const f=await fixture();t.after(f.close);const login=await f.login();const headers={Cookie:login.headers.get("set-cookie")!.split(";")[0]};
	f.services.env.ADMIN_PASSWORD="a-new-test-password-2026";assert.equal((await f.request("/api/me","GET",undefined,headers)).status,401);
	f.services.env.ADMIN_PASSWORD=password;f.advance(8*60*60*1000+1);assert.equal((await f.request("/api/me","GET",undefined,headers)).status,401);
});
test("login rejects foreign/missing Origin, oversized bodies and alternative login bypasses",async t=>{
	const f=await fixture();t.after(f.close);
	assert.equal((await f.request("/api/auth/password","POST",{password},{Origin:"https://evil.example"})).status,403);
	assert.equal((await f.app.request(`${origin}/api/auth/password`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})})).status,403);
	assert.equal((await f.request("/api/auth/password","POST",{password:"x".repeat(3000)})).status,413);
	assert.equal((await f.request("/api/auth/github")).status,404);assert.equal((await f.request("/api/auth/github/callback")).status,404);assert.equal((await f.request("/api/auth/development","POST",{secret:"anything"})).status,404);
});
test("failed password attempts are durably rate limited, then recover after the window",async t=>{
	const f=await fixture();t.after(f.close);
	for(let i=0;i<5;i++)assert.equal((await f.request("/api/auth/password","POST",{password:"wrong-password"})).status,401);
	assert.equal((await f.login()).status,429);f.advance(15*60*1000+1);assert.equal((await f.login()).status,200);
});
test("missing or weak configured password never creates an authenticated session",async t=>{
	const f=await fixture();t.after(f.close);
	delete f.services.env.ADMIN_PASSWORD;const missing=await f.login();assert.equal(missing.status,503);assert.equal(missing.headers.get("set-cookie"),null);
	f.services.env.ADMIN_PASSWORD="short";assert.equal((await f.login()).status,503);
});
test("free storage keeps private objects hidden and publishes only explicit immutable media",async t=>{
	const f=await fixture();t.after(f.close);
	const bytes=new TextEncoder().encode("test image bytes"),hash=await sha256(bytes.slice().buffer),key=`published/${hash}.png`;
	await putPrivateObject(f.services,"media/285582250/private.png",bytes,"image/png");
	assert.deepEqual(await readLimited((await getPrivateObject(f.services,"media/285582250/private.png"))!.body,100),bytes);
	assert.equal((await f.request("/api/public/media/media/285582250/private.png")).status,404);
	assert.equal((await f.request(`/api/public/media/${key}`)).status,404);
	const published=await putPublicObject(f.services,key,bytes,"image/png");assert.equal(published.provider,"d1");assert.equal(published.url,`${origin}/api/public/media/${key}`);
	const publicResponse=await f.request(`/api/public/media/${key}`);assert.equal(publicResponse.status,200);assert.equal(publicResponse.headers.get("Content-Type"),"image/png");assert.deepEqual(new Uint8Array(await publicResponse.arrayBuffer()),bytes);
	await assert.rejects(putPublicObject(f.services,key,new Uint8Array([1]),"image/png"),/immutable/);
	assert.deepEqual(await readLimited((await getPublicObject(f.services,key))!.body,100),bytes);
});
test("free uploads enforce file and total quotas without any R2 operation",async t=>{
	const f=await fixture();t.after(f.close);
	const forbidden=()=>{throw new Error("A paid storage provider was called");};f.services.env.PRIVATE_MEDIA={put:forbidden,get:forbidden,delete:forbidden,list:forbidden};
	await assert.rejects(putPrivateObject(f.services,"media/large.png",new Uint8Array(FREE_MEDIA_LIMIT+1),"image/png"),/256 KiB/);
	const bytes=new Uint8Array(FREE_MEDIA_LIMIT);
	for(let i=0;i<FREE_STORAGE_LIMIT/FREE_MEDIA_LIMIT-1;i++)await putPrivateObject(f.services,`media/image-${i}.png`,bytes,"image/png");
	const result=await Promise.allSettled([putPrivateObject(f.services,"media/race-one.png",bytes,"image/png"),putPrivateObject(f.services,"media/race-two.png",bytes,"image/png")]);
	assert.equal(result.filter(x=>x.status==="fulfilled").length,1);assert.equal(result.filter(x=>x.status==="rejected").length,1);
	const total=await f.services.store.db.query({sql:"SELECT SUM(size) AS bytes FROM free_objects"});assert.equal(total.rows[0].bytes,FREE_STORAGE_LIMIT);
});
test("free D1 backups can be verified and downloaded only with a management session",async t=>{
	const f=await fixture();t.after(f.close);await f.services.store.create("settings","site",{title:"Private draft"});const backup=await createBackup(f.services,"free-test-backup");assert.equal(backup.recordCount,1);
	assert.equal((await f.request(`/api/maintenance/backups/${backup.id}/download`)).status,401);
	const login=await f.login(),headers={Cookie:login.headers.get("set-cookie")!.split(";")[0]};const response=await f.request(`/api/maintenance/backups/${backup.id}/download`,"GET",undefined,headers);
	assert.equal(response.status,200);assert.ok(response.headers.get("Content-Disposition")?.includes("attachment"));assert.ok(JSON.stringify(await response.json()).includes("Private draft"));
});
test("free mode needs no OAuth, R2, Queue or mail credentials and never sends queued mail",async t=>{
	const f=await fixture();t.after(f.close);Object.assign(f.services.env,{GITHUB_PUBLISH_TOKEN:"test-token-only",GITHUB_BUILD_CHECK_NAME:"Workers Builds: test",GITHUB_BUILD_CHECK_APP_ID:"85455",CLOUDFLARE_ACCOUNT_ID:"test-account",CLOUDFLARE_API_TOKEN:"test-api-token",BLOG_WORKER_NAME:"test-worker",DB:{}});
	assert.deepEqual(productionRequirements(f.services.env),[]);
	await dispatchPublicationTask(f.services,"already-durable-task");
	await f.services.store.create("outbox","never-send",{status:"pending",recipient:"test@example.com"});f.services.fetcher=async()=>{throw new Error("Unexpected external mail operation");};await runMaintenance(f.services);
	assert.equal((await f.services.store.get<{status:string}>("outbox","never-send"))!.value.status,"pending");
});
test("a repository-scoped token uses GitHub APIs without requiring an OAuth or GitHub App login",async t=>{
	const f=await fixture();t.after(f.close);f.services.env.GITHUB_PUBLISH_TOKEN="test-repository-token";let calls=0;
	f.services.fetcher=async(input,init)=>{calls++;assert.equal(String(input),"https://api.github.com/repos/example/blog/git/ref/heads/main");assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer test-repository-token");return Response.json({object:{sha:"a".repeat(40)}});};
	assert.equal(await (await githubClient(f.services)).head(),"a".repeat(40));assert.equal(calls,1);
});
test("baseline initialize requires password and CSRF and never replaces later edits",async t=>{
	const f=await fixture();t.after(f.close);f.services.env.GITHUB_REPOSITORY="Nocticur/Firefly-hyde";
	assert.equal((await f.request("/api/maintenance/initialize","POST",{})).status,401);
	const login=await f.login(),session=await login.json() as {csrf:string};const headers={Cookie:login.headers.get("set-cookie")!.split(";")[0],"X-CSRF-Token":session.csrf};
	assert.equal((await f.request("/api/maintenance/initialize","POST",{},headers)).status,200);
	const rows=await f.services.store.all<{raw:string}>("article");assert.equal(rows.length,16);
	await f.services.store.update("article",rows[0].id,rows[0].version,{...rows[0].value,raw:"private edited source"});
	assert.equal((await f.request("/api/maintenance/initialize","POST",{},headers)).status,200);
	assert.equal((await f.services.store.get<{raw:string}>("article",rows[0].id))!.value.raw,"private edited source");
});
test("backup cleanup rejects missing CSRF and stale versions, then frees the stored object",async t=>{
	const f=await fixture();t.after(f.close);await createBackup(f.services,"cleanup-test");
	const login=await f.login(),session=await login.json() as {csrf:string};const cookie=login.headers.get("set-cookie")!.split(";")[0];
	assert.equal((await f.request("/api/maintenance/backups/cleanup-test","DELETE",{version:1},{Cookie:cookie})).status,403);
	const headers={Cookie:cookie,"X-CSRF-Token":session.csrf};assert.equal((await f.request("/api/maintenance/backups/cleanup-test","DELETE",{version:99},headers)).status,409);
	assert.equal((await f.request("/api/maintenance/backups/cleanup-test","DELETE",{version:1},headers)).status,200);
	const objects=await f.services.store.db.query({sql:"SELECT key FROM free_objects WHERE key LIKE 'backups/%'"});assert.equal(objects.rows.length,0);
});
