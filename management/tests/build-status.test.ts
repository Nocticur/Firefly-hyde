import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { verifyBuild,verifyProduction,githubClient,assertPublishingConfiguration } from "../src/integrations.ts";
import type { Services } from "../src/types.ts";

const target="a".repeat(40),older="b".repeat(40),checkName="Explicit Cloudflare build check",appId=12345;
const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
function fixture(){
  const calls:string[]=[];let runs:any[]=[];let productionSha=older;
  const services:Services={store:null as any,now:Date.now,env:{ENVIRONMENT:"production",PLATFORM:"cloudflare",GITHUB_REPOSITORY:"Nocticur/Firefly-hyde",GITHUB_BRANCH:"main",GITHUB_APP_ID:"1",GITHUB_APP_INSTALLATION_ID:"2",GITHUB_APP_PRIVATE_KEY:privateKey,GITHUB_BUILD_CHECK_NAME:checkName,GITHUB_BUILD_CHECK_APP_ID:String(appId),BLOG_ORIGIN:"https://blog.example.test",CLOUDFLARE_ACCOUNT_ID:"test-account",CLOUDFLARE_API_TOKEN:"test-platform-token",BLOG_WORKER_NAME:"test-worker"},fetcher:async(url,init)=>{
    const path=new URL(String(url));calls.push(path.href);
    if(path.href==="https://api.github.com/app/installations/2/access_tokens"){
      const body=JSON.parse(String(init?.body));assert.deepEqual(body.repositories,["Firefly-hyde"]);assert.equal(body.permissions.contents,"write");assert.equal(body.permissions.checks,"read");return Response.json({token:"test-transient-installation-token"});
    }
    if(path.origin==="https://api.github.com" && path.pathname===`/repos/Nocticur/Firefly-hyde/commits/${target}/check-runs`){return Response.json({total_count:runs.length,check_runs:runs});}
    if(path.origin==="https://api.cloudflare.com" && path.pathname.endsWith("/deployments"))return Response.json({success:true,result:{deployments:[{created_on:"2026-10-09T00:00:00Z",versions:[{version_id:"current-version",percentage:100}]}]}});
    if(path.origin==="https://api.cloudflare.com" && path.pathname.endsWith("/versions/current-version"))return Response.json({success:true,result:{annotations:{"workers/tag":productionSha}}});
    throw new Error("Unexpected external call in build evidence test");
  }};
  return {services,calls,setRuns:(value:any[])=>runs=value,setProductionSha:(value:string)=>productionSha=value};
}
const run=(id:number,status="completed",conclusion:string|null="success",extra:Record<string,unknown>={})=>({id,name:checkName,app:{id:appId},head_sha:target,check_suite:{head_sha:target},status,conclusion,...extra});

test("build evidence requires an explicit check name and numeric App ID before any request",async()=>{
  const f=fixture();delete f.services.env.GITHUB_BUILD_CHECK_NAME;
  assert.throws(()=>assertPublishingConfiguration(f.services),(e:any)=>e.code==="CONFIG_REQUIRED");
  await assert.rejects(()=>verifyBuild(f.services,target,async()=>{throw new Error("must not request");}),(e:any)=>e.code==="CONFIG_REQUIRED");
  f.services.env.GITHUB_BUILD_CHECK_NAME=checkName;f.services.env.GITHUB_BUILD_CHECK_APP_ID="not-a-number";
  await assert.rejects(()=>verifyBuild(f.services,target,async()=>({})),(e:any)=>e.code==="BUILD_CHECK_CONFIG_INVALID");assert.equal(f.calls.length,0);
});

test("failed old commits, wrong Check names, foreign App IDs and mismatched suite SHAs cannot mark this target failed",async()=>{
  const f=fixture();const evidence=await verifyBuild(f.services,target,async()=>({total_count:4,check_runs:[run(10,"completed","failure",{head_sha:older}),run(20,"completed","failure",{name:"Other pipeline"}),run(30,"completed","failure",{app:{id:99999}}),run(40,"completed","failure",{check_suite:{head_sha:older}})]}));
  assert.equal(evidence.status,"waiting");assert.equal(evidence.checkRunId,undefined);assert.equal(evidence.targetSha,target);
});

test("each completed unsuccessful build conclusion is distinguished from queued and incomplete runs",async t=>{
  for(const conclusion of ["failure","timed_out","cancelled","action_required","startup_failure"]){await t.test(conclusion,async()=>{const f=fixture();const evidence=await verifyBuild(f.services,target,async()=>({total_count:1,check_runs:[run(1,"completed",conclusion)]}));assert.equal(evidence.status,"failed");assert.equal(evidence.conclusion,conclusion);});}
  for(const status of ["queued","in_progress","waiting","pending"]){await t.test(status,async()=>{const f=fixture();const evidence=await verifyBuild(f.services,target,async()=>({total_count:1,check_runs:[run(1,status,null)]}));assert.equal(evidence.status,"waiting");});}
  for(const conclusion of ["neutral","skipped",null]){const f=fixture();assert.equal((await verifyBuild(f.services,target,async()=>({total_count:1,check_runs:[run(1,"completed",conclusion)]}))).status,"waiting");}
});

test("a newer queued rerun supersedes an older failure; the latest completed matching rerun controls the result",async()=>{
  const f=fixture();const evaluate=(runs:any[])=>verifyBuild(f.services,target,async()=>({total_count:runs.length,check_runs:runs}));
  assert.equal((await evaluate([run(10,"completed","failure"),run(11,"queued",null)])).status,"waiting");
  assert.equal((await evaluate([run(10,"completed","success"),run(12,"completed","failure")])).status,"failed");
  const success=await evaluate([run(10,"completed","failure"),run(13,"completed","success")]);assert.equal(success.status,"succeeded");assert.equal(success.checkRunId,13);
});

test("pagination selects the matching target check and truncated inventories remain unconfirmed",async()=>{
  const f=fixture(),pages:string[]=[];
  const evidence=await verifyBuild(f.services,target,async path=>{pages.push(path);return path.endsWith("page=1")?{total_count:101,check_runs:Array.from({length:100},(_,i)=>run(i+1,"completed","failure",{name:"Other check"}))}:{total_count:101,check_runs:[run(101,"completed","failure")]};});
  assert.equal(evidence.status,"failed");assert.equal(evidence.checkRunId,101);assert.equal(pages.length,2);
  await assert.rejects(()=>verifyBuild(f.services,target,async()=>({total_count:1000,check_runs:Array.from({length:100},(_,i)=>run(i+1))})),(e:any)=>e.code==="BUILD_CHECKS_TRUNCATED");
});

test("target-specific failed checks report failure independently of an older live Worker; an old live SHA alone means waiting",async()=>{
  const f=fixture();f.setRuns([run(1,"completed","failure")]);
  const failed=await verifyProduction(f.services,target,"test-content-hash");assert.equal(failed.status,"failed");assert.equal(failed.build?.checkRunId,1);assert.equal(failed.productionSha,undefined);assert(f.calls.every(url=>!url.includes("api.cloudflare.com")));
  f.setRuns([run(2,"completed","success")]);const waiting=await verifyProduction(f.services,target,"test-content-hash");assert.equal(waiting.status,"waiting");assert.equal(waiting.productionSha,older);assert.equal(waiting.build?.status,"succeeded");assert.equal(waiting.verified,false);
});

test("GitHub App checks access is repository scoped and successful CI does not bypass production verification",async()=>{
  const f=fixture();f.setRuns([run(3)]);const git=await githubClient(f.services);
  assert.equal((await git.buildStatus(target)).status,"succeeded");assert(f.calls.some(url=>url.includes(`/repos/Nocticur/Firefly-hyde/commits/${target}/check-runs`)));
  const result=await verifyProduction(f.services,target,"test-content-hash",git);assert.equal(result.verified,false);assert.equal(result.status,"waiting");assert.equal(f.calls.filter(url=>url.endsWith("/access_tokens")).length,1);
});
