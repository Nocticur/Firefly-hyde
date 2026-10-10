import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { localDatabase } from "../src/local-database.ts";
import { RecordStore } from "../src/store.ts";
import { importBaseline,publishArticleRaw } from "../src/content.ts";
import { createBackup,restoreBackup,runMaintenance,verifyBackup } from "../src/maintenance.ts";
import { createServices } from "../src/runtime.ts";
import { sha256 } from "../src/security.ts";
import { putPrivateObject } from "../src/storage.ts";
import type { Article,Friend,Services } from "../src/types.ts";

const source="---\n# original YAML comment\ntitle: Original title # retain this\npublished: 2026-09-10\nslug: 中文固定\ndraft: false\nunknown: {nested: [one, two]} # retain unknown\n---\n\n<Component prop=\"exact\" />\n<!-- HTML stays -->\n```ts\nconst a = 1;\n```\n";
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"management-core-")),path=join(dir,"db.sqlite"),db=await localDatabase(path),store=new RecordStore(db);await store.migrate();
  let now=Date.parse("2026-10-09T00:00:00Z");
  const services:Services={store,now:()=>now,fetcher:fetch,env:{ENVIRONMENT:"development",PLATFORM:"local",NODE_ENV:"development",DEV_AUTH_SECRET:"test-local-session-key",ADMIN_ORIGIN:"http://localhost",BLOG_ORIGIN:"https://blog.example.test",MEDIA_ORIGIN:"http://localhost/media/",LOCAL_MEDIA_PATH:join(dir,"media"),IP_HASH_SECRET:"test-hash-secret",GITHUB_REPOSITORY:"example/blog"}};
  store.clock=services.now;
  await importBaseline(services,{repository:"example/blog",branch:"main",articles:[{id:"baseline-article",path:"src/content/posts/中文固定.mdx",slug:"中文固定",raw:source,draft:false}],settings:{title:"Seeded title",signature:"line one\nline two"},navigation:[{id:"home",name:"主页",url:"/"}]});
  const app=createApp(services);
  const login=await app.request("http://localhost/api/auth/development",{method:"POST",headers:{"Content-Type":"application/json",Origin:"http://localhost"},body:JSON.stringify({secret:services.env.DEV_AUTH_SECRET})});assert.equal(login.status,200);
  const session=await login.json() as {csrf:string},cookie=login.headers.get("set-cookie")!.split(";")[0];
  const request=async(path:string,method="GET",body?:unknown,extra:Record<string,string>={})=>app.request(`http://localhost${path}`,{method,headers:{Cookie:cookie,"X-CSRF-Token":session.csrf,"Content-Type":"application/json",Origin:"http://localhost",...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {dir,path,db,store,services,app,request,cookie,csrf:session.csrf,advance:(ms:number)=>{now+=ms;},close:async()=>{await db.close?.();await rm(dir,{recursive:true,force:true});}};
}

test("persistent baseline is idempotent; article source, settings and navigation survive process/database restart",async()=>{
  const f=await fixture();try{
    assert.equal((await f.request("/api/articles")).status,200);
    const article=await (await f.request("/api/articles/baseline-article")).json() as Article&{version:number};assert.equal(article.raw,source);assert.equal(article.publishedVersion,1);
    assert.equal((await (await f.request("/api/settings")).json()).values.title,"Seeded title");assert.equal((await (await f.request("/api/navigation")).json()).items[0].id,"home");
    const result=await importBaseline(f.services,{repository:"example/blog",branch:"main",articles:[]});assert.deepEqual(result,{imported:0,alreadyImported:true});
    await f.db.close?.();const reopened=await localDatabase(f.path),store=new RecordStore(reopened);
    assert.equal((await store.get<Article>("article","baseline-article"))?.value.raw,source);assert.equal((await store.all("history")).length,1);await reopened.close?.();
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("authentication, CSRF and optimistic source saves preserve current draft and immutable history",async()=>{
  const f=await fixture();try{
    assert.equal((await f.app.request("http://localhost/api/articles")).status,401);
    const raw=source.replace("Original title","A new title")+"\nPrivate edit\n";
    const body={raw,path:"src/content/posts/中文固定.mdx",slug:"中文固定",draft:false,version:1};
    assert.equal((await f.request("/api/articles/baseline-article","PUT",body,{"X-CSRF-Token":"forged"})).status,403);
    assert.equal((await f.request("/api/articles/baseline-article","PUT",body,{Origin:"https://attacker.test"})).status,403);
    const saved=await f.request("/api/articles/baseline-article","PUT",body);assert.equal(saved.status,200);assert.equal((await saved.json()).raw,raw);
    const conflict=await f.request("/api/articles/baseline-article","PUT",body);assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.details.current.raw,raw);
    const restore=await f.request("/api/articles/baseline-article/restore","POST",{version:1,expectedVersion:2});assert.equal(restore.status,200);assert.equal((await restore.json()).raw,source);
    const history=await (await f.request("/api/articles/baseline-article/history")).json();assert.equal(history.items.length,3);assert.equal(history.items.find((x:any)=>x.version===2).raw,raw);assert.equal(history.items[0].reason,"restore");
    const renamed=await f.request("/api/articles/baseline-article","PUT",{...body,raw:source,slug:"新地址",version:3});assert.equal(renamed.status,200);assert.deepEqual((await renamed.json()).redirects,["中文固定"]);
    const created=await f.request("/api/articles","POST",{path:"src/content/posts/private.md",slug:"新草稿",raw:source.replace("中文固定","新草稿"),draft:false});assert.equal(created.status,201);const privateArticle=await created.json();assert.equal(privateArticle.draft,true);assert.equal(privateArticle.publishedVersion,undefined);
    assert.equal((await f.app.request(`http://localhost/api/public/comments?articleId=${privateArticle.id}`)).status,404);
  }finally{await f.close();}
});

test("two database connections saving the same expected version allow exactly one writer",async()=>{
  const f=await fixture(),second=await localDatabase(f.path);try{
    const competing=new RecordStore(second,f.services.now),first=await f.store.get<Article>("article","baseline-article");assert(first);
    const results=await Promise.allSettled([f.store.update("article",first.id,first.version,{...first.value,title:"First writer"}),competing.update("article",first.id,first.version,{...first.value,title:"Second writer"})]);
    assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(results.filter(x=>x.status==="rejected").length,1);
    const failure=results.find(x=>x.status==="rejected") as PromiseRejectedResult;assert.equal(failure.reason.code,"VERSION_CONFLICT");assert.equal((await f.store.get("article",first.id))?.version,2);
  }finally{await second.close?.();await f.close();}
});

test("the 16-article baseline uses a single atomic batch within D1 query and bind limits",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"management-d1-budget-")),db=await localDatabase(join(dir,"db.sqlite"));try{
    const batches:Array<Array<{sql:string;params?:unknown[]}>>=[],store=new RecordStore({...db,batch:async statements=>{batches.push(statements);return db.batch(statements);}});await store.migrate();
    const services:Services={store,now:Date.now,fetcher:fetch,env:{ENVIRONMENT:"development",PLATFORM:"local"}};
    await importBaseline(services,{repository:"example/blog",branch:"main",articles:Array.from({length:16},(_,i)=>({id:`stable-${i}`,path:`src/content/posts/article-${i}.md`,slug:`fixed-${i}`,raw:source,draft:false})),settings:{title:"Baseline"},navigation:[]});
    const baselineBatch=batches.at(-1)!;assert(baselineBatch.length<20);assert(baselineBatch.every(x=>(x.params?.length??0)<=100));assert.equal((await store.all("article")).length,16);assert.equal((await store.all("history")).length,16);
  }finally{await db.close?.();await rm(dir,{recursive:true,force:true});}
});

test("published raw changes only owned scalar ranges and preserves YAML comments, unknown blocks, MDX and HTML",()=>{
  const raw=source.replace("draft: false","draft: true");const output=publishArticleRaw({raw,slug:"新的中文slug"});
  assert.equal(output,raw.replace("draft: true","draft: false").replace("slug: 中文固定",'slug: "新的中文slug"'));
  assert.equal(publishArticleRaw({raw:source,slug:"中文固定"}),source);
});

test("comments hide visitor email, retain deleted reply links, enforce bans and persistent rate limits",async()=>{
  const f=await fixture();try{
    const body={articleId:"baseline-article",name:"Visitor",text:'<script>alert("plain text")</script>',email:"visitor@example.test",turnstileToken:`development:${f.services.env.DEV_AUTH_SECRET}`};
    const comment=await f.request("/api/public/comments","POST",body);assert.equal(comment.status,201);const parent=(await comment.json()).item;assert.equal(parent.text,body.text);assert(!("email"in parent));assert(!("authorKey"in parent));
    const reply=await f.request("/api/public/comments","POST",{...body,name:"Reply",text:"Reply stays",parentId:parent.id,email:"reply@example.test"});assert.equal(reply.status,201);
    const admin=await (await f.request("/api/comments")).json();assert.equal(admin.items.find((x:any)=>x.id===parent.id).email,body.email);
    assert.equal((await f.request(`/api/comments/${parent.id}/delete`,"POST",{version:1})).status,200);
    const publicItems=(await (await f.request("/api/public/comments?articleId=baseline-article")).json()).items;assert.equal(publicItems.find((x:any)=>x.id===parent.id).text,"[已删除]");assert.equal(publicItems.find((x:any)=>x.parentId===parent.id).text,"Reply stays");assert(publicItems.every((x:any)=>!x.email));
    const ban=await f.request("/api/bans","POST",{commentId:parent.id,reason:"Spam"});assert.equal(ban.status,201);const blocked=await f.request("/api/public/comments","POST",body);assert.equal(blocked.status,403);const banned=await ban.json();assert.equal((await f.request(`/api/bans/${banned.id}`,"DELETE",{version:banned.version})).status,200);
    assert.equal((await f.request("/api/public/comments","POST",body)).status,201);
    for(let i=0;i<3;i++)await f.request("/api/public/comments","POST",{...body,email:`limit${i}@example.test`});assert.equal((await f.request("/api/public/comments","POST",body)).status,429);
  }finally{await f.close();}
});

test("friend review and mail outbox are atomic; approval is private until a verified publication",async()=>{
  const f=await fixture();try{
    const application=await f.request("/api/public/friends","POST",{name:"A friend",url:"https://friend.example.test",avatar:"https://friend.example.test/avatar.png",description:"Description",email:"friend@example.test",message:"Keep application notes",turnstileToken:`development:${f.services.env.DEV_AUTH_SECRET}`});assert.equal(application.status,202);const {id}=await application.json();
    assert.equal((await f.request(`/api/friends/${id}/approve`,"POST",{version:1,group:"Friends",order:2})).status,200);
    assert.equal((await f.store.all<{status:string}>("outbox"))[0].value.status,"waiting");assert.deepEqual((await (await f.request("/api/public/friends")).json()).items,[]);
    assert.equal((await f.request(`/api/friends/${id}/reject`,"POST",{version:1,reason:"late decision"})).status,409);
    const friend=(await f.store.get<Friend>("friend",id))!;assert.equal(friend.value.message,"Keep application notes");
    await f.store.create("public-friend",id,{...friend.value,live:true});const outbox=(await f.store.all<any>("outbox"))[0];await f.store.update("outbox",outbox.id,outbox.version,{...outbox.value,status:"pending"});
    const deliveries:Array<{key:string;text:string}>=[],mailServices:Services={...f.services,env:{...f.services.env,ENVIRONMENT:"production",RESEND_API_KEY:"test-resend-key",MAIL_FROM:"test@example.test"},fetcher:async(_url,init)=>{deliveries.push({key:new Headers(init?.headers).get("Idempotency-Key")!,text:JSON.parse(String(init?.body)).text});if(deliveries.length===1)throw new Error("Lost response after acceptance");return Response.json({id:"provider-email-id"});}};
    await runMaintenance(mailServices);assert.equal((await f.store.all<any>("outbox"))[0].value.status,"unknown");f.advance(61_000);await runMaintenance(mailServices);assert.equal((await f.store.all<any>("outbox"))[0].value.status,"sent");assert.equal(deliveries.length,2);assert.equal(deliveries[0].key,deliveries[1].key);assert.match(deliveries[1].text,/production|上线|https:\/\/blog/);
  }finally{await f.close();}
});

test("verified private backups restore stable IDs, exact histories, media references and pending tasks; corrupted media blocks restore",async()=>{
  const f=await fixture();try{
    const bytes=new TextEncoder().encode("private media bytes"),digest=await sha256(bytes.slice().buffer);await putPrivateObject(f.services,"drafts/1/media.bin",bytes);
    await f.store.create("media","media-id",{id:"media-id",key:"drafts/1/media.bin",owner:1,filename:"media.bin",contentType:"application/octet-stream",size:bytes.length,status:"private",sha256:digest,provider:"local",alt:"alt",caption:"caption",createdAt:new Date(f.services.now()).toISOString()});
    await f.store.create("task","unfinished",{id:"unfinished",type:"publication",status:"unknown",publicationId:"publication-id",payload:{},attempts:1,createdAt:new Date(f.services.now()).toISOString(),updatedAt:new Date(f.services.now()).toISOString()});
    const backup=await createBackup(f.services),article=(await f.store.get<Article>("article","baseline-article"))!;await f.store.update("article",article.id,article.version,{...article.value,raw:source+"later private draft"});
    assert.equal((await verifyBackup(f.services,backup.id)).mutated,false);assert.equal((await f.store.get<Article>("article",article.id))?.value.raw,source+"later private draft");
    const restored=await restoreBackup(f.services,backup.id,"RESTORE_PRIVATE_DATA");assert(restored.restored>0);assert.equal((await f.store.get<Article>("article",article.id))?.value.raw,source);assert.equal((await f.store.get<any>("task","unfinished"))?.value.status,"unknown");assert.equal((await f.store.get<any>("media","media-id"))?.value.sha256,digest);assert.equal((await f.store.all("session")).length,0);
    await putPrivateObject(f.services,"drafts/1/media.bin",new TextEncoder().encode("truncated"),"application/octet-stream",true);
    await assert.rejects(()=>restoreBackup(f.services,backup.id,"RESTORE_PRIVATE_DATA"),(error:any)=>error.code==="MEDIA_CHECKSUM_FAILED");
  }finally{await f.close();}
});

test("GitHub OAuth uses fixed callback, one-use state, numeric administrator binding and Secure HttpOnly cookies",async()=>{
  const f=await fixture();try{
    let userId=987654;
    const services:Services={...f.services,env:{...f.services.env,ENVIRONMENT:"production",PLATFORM:"cloudflare",ADMIN_ORIGIN:"https://admin.example.test",ADMIN_GITHUB_USER_ID:"987654",GITHUB_OAUTH_CLIENT_ID:"test-client-id",GITHUB_OAUTH_CLIENT_SECRET:"test-client-secret"},fetcher:async(url,init)=>{
      if(String(url)==="https://github.com/login/oauth/access_token"){
        assert.equal(JSON.parse(String(init?.body)).redirect_uri,"https://admin.example.test/api/auth/github/callback");return Response.json({access_token:"test-transient-access-token"});
      }
      if(String(url)==="https://api.github.com/user")return Response.json({id:userId,login:"admin-login"});
      throw new Error("Unexpected mocked external call");
    }},app=createApp(services);
    const begin=await app.request("https://admin.example.test/api/auth/github");assert.equal(begin.status,302);const location=new URL(begin.headers.get("location")!);assert.equal(location.searchParams.get("redirect_uri"),"https://admin.example.test/api/auth/github/callback");
    const state=location.searchParams.get("state")!,cookie=begin.headers.get("set-cookie")!;assert.match(cookie,/__Host-mgmt-state/);assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
    assert.equal((await app.request(`https://admin.example.test/api/auth/github/callback?code=test-code&state=${state}`,{headers:{Cookie:"__Host-mgmt-state=forged"}})).status,403);
    const callback=await app.request(`https://admin.example.test/api/auth/github/callback?code=test-code&state=${state}`,{headers:{Cookie:cookie.split(";")[0]}});assert.equal(callback.status,302);assert.equal(callback.headers.get("location"),"https://admin.example.test/");assert.match(callback.headers.get("set-cookie")!,/__Host-mgmt-session=/);assert.match(callback.headers.get("set-cookie")!,/Secure/);
    assert.equal((await app.request(`https://admin.example.test/api/auth/github/callback?code=test-code&state=${state}`,{headers:{Cookie:cookie.split(";")[0]}})).status,403);
    const wrong=await app.request("https://admin.example.test/api/auth/github"),wrongState=new URL(wrong.headers.get("location")!).searchParams.get("state");userId=123;
    assert.equal((await app.request(`https://admin.example.test/api/auth/github/callback?code=test-code&state=${wrongState}`,{headers:{Cookie:wrong.headers.get("set-cookie")!.split(";")[0]}})).status,403);
    assert.equal((await app.request("https://unexpected.example.test/api/auth/github")).status,403);
    const storedSessions=await f.store.all<any>("session");assert(storedSessions.every(x=>!("access_token"in x.value)));
  }finally{await f.close();}
});

test("production does not fall back to local memory or disk when persistent bindings are missing",async()=>{
  await assert.rejects(()=>createServices({ENVIRONMENT:"production",PLATFORM:"cloudflare"}),(error:any)=>error.code==="CONFIG_REQUIRED");
  await assert.rejects(()=>createServices({ENVIRONMENT:"production"}),(error:any)=>error.code==="CONFIG_REQUIRED");
});
