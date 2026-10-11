import type { Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ApiError, required } from "./errors.ts";
import { assertWriteOrigin,constantEqual,originFor,randomToken,rateLimit,sha256,visitorKey } from "./security.ts";
import type { AppEnv, Services, Session } from "./types.ts";

const cookieName=(services:Services,state=false)=>`${services.env.ENVIRONMENT==="development" ? "" : "__Host-"}mgmt-${state ? "state" : "session"}`;
const options=(services:Services,maxAge:number)=>({httpOnly:true,secure:services.env.ENVIRONMENT!=="development",sameSite:"Lax" as const,path:"/",maxAge});
async function passwordFingerprint(services:Services,password?:string){
  const configured=required(services.env.ADMIN_PASSWORD,"ADMIN_PASSWORD");
  if(configured.length<3 || configured.length>10)throw new ApiError(503,"CONFIG_INVALID","ADMIN_PASSWORD must contain 3 to 10 characters");
  // Keep the original password in the runtime Secret; persist only a keyed fingerprint.
  const encoder=new TextEncoder();
  const secret=required(services.env.IP_HASH_SECRET,"IP_HASH_SECRET");
  if(secret.length<32)throw new ApiError(503,"CONFIG_INVALID","IP_HASH_SECRET must contain at least 32 random characters");
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const fingerprint=await crypto.subtle.sign("HMAC",key,encoder.encode(`admin-password:${password ?? configured}`));
  return Array.from(new Uint8Array(fingerprint),x=>x.toString(16).padStart(2,"0")).join("");
}
async function issueSession(c:any,user:Session["user"],fingerprint?:string){
  const services:Services=c.get("services");const token=randomToken();
  const session:Session={user,csrf:randomToken(),expiresAt:services.now()+8*60*60*1000,...(fingerprint ? {passwordFingerprint:fingerprint} : {})};
  await services.store.create("session",await sha256(token),session);
  setCookie(c,cookieName(services),token,options(services,8*60*60));
  return session;
}
export const authenticate:MiddlewareHandler<AppEnv>=async(c,next)=>{
  const services=c.get("services");const token=getCookie(c,cookieName(services));
  if(!token)throw new ApiError(401,"UNAUTHENTICATED","请先登录后台");
  const row=await services.store.get<Session>("session",await sha256(token));
  if(!row || row.value.expiresAt<=services.now())throw new ApiError(401,"SESSION_EXPIRED","Sign in again");
  if(services.env.AUTH_MODE === "password" && (!row.value.passwordFingerprint || !constantEqual(row.value.passwordFingerprint,await passwordFingerprint(services))))throw new ApiError(401,"SESSION_EXPIRED","密码已更新，请重新登录");
  const allowed=services.env.ADMIN_GITHUB_USER_ID;
  if(services.env.ENVIRONMENT!=="development" && String(row.value.user.id)!==required(allowed,"ADMIN_GITHUB_USER_ID"))throw new ApiError(403,"ADMIN_ONLY","This account is not the configured administrator");
  c.set("session",row.value);
  if(!["GET","HEAD","OPTIONS"].includes(c.req.method)){
    assertWriteOrigin(c);
    if(!constantEqual(c.req.header("X-CSRF-Token") ?? "",row.value.csrf))throw new ApiError(403,"CSRF_FAILED","Refresh this page before saving");
  }
  await next();
};
export function registerAuth(app:Hono<AppEnv>){
  app.post("/api/auth/password",bodyLimit({maxSize:2048,onError:c=>c.json({error:{code:"PAYLOAD_TOO_LARGE",message:"登录请求过大"}},413)}),async c=>{
    const services=c.get("services");
    if(services.env.AUTH_MODE!=="password")throw new ApiError(404,"NOT_FOUND","Not found");
    const origin=originFor(services);
    // Login has no session CSRF token yet; require an exact same-origin request.
    if(c.req.header("Origin")!==origin || new URL(c.req.url).origin!==origin)throw new ApiError(403,"ORIGIN_REJECTED","请从本站后台页面登录");
    const ip=await visitorKey(c);
    await rateLimit(services,"password-login:all",60,15*60*1000);
    await rateLimit(services,`password-login:${ip}`,5,15*60*1000);
    await services.store.db.query({sql:"DELETE FROM records WHERE kind IN ('rate','session','oauth-state') AND CAST(json_extract(value,'$.expiresAt') AS INTEGER)<=?",params:[services.now()]});
    const input=z.object({password:z.string().min(3).max(10)}).strict().parse(await c.req.json());
    const expected=await passwordFingerprint(services);
    if(!constantEqual(expected,await passwordFingerprint(services,input.password)))throw new ApiError(401,"LOGIN_FAILED","密码不正确，请重试");
    const id=Number(required(services.env.ADMIN_GITHUB_USER_ID,"ADMIN_GITHUB_USER_ID"));
    if(!Number.isSafeInteger(id)||id<=0)throw new ApiError(503,"CONFIG_INVALID","Configure a numeric administrator ID");
    const session=await issueSession(c,{id,login:"Nocticur"},expected);
    return c.json({user:session.user,csrf:session.csrf});
  });
  app.get("/api/auth/github",async c=>{
    const services=c.get("services");
    if(services.env.AUTH_MODE === "password")throw new ApiError(404,"NOT_FOUND","Not found");
    const clientId=required(services.env.GITHUB_OAUTH_CLIENT_ID,"GITHUB_OAUTH_CLIENT_ID");
    if(!/^\d+$/.test(required(services.env.ADMIN_GITHUB_USER_ID,"ADMIN_GITHUB_USER_ID")))throw new ApiError(503,"CONFIG_INVALID","ADMIN_GITHUB_USER_ID must be a numeric GitHub ID");
    const origin=originFor(services);
    if(new URL(c.req.url).origin!==origin)throw new ApiError(403,"ORIGIN_REJECTED","Use the configured administration domain");
    await rateLimit(services,"oauth:start",60,60*1000);
    const state=randomToken();await services.store.create("oauth-state",await sha256(state),{expiresAt:services.now()+10*60*1000});
    setCookie(c,cookieName(services,true),state,options(services,600));
    const url=new URL("https://github.com/login/oauth/authorize");
    url.search=new URLSearchParams({client_id:clientId,redirect_uri:`${origin}/api/auth/github/callback`,state,scope:"read:user"}).toString();
    return c.redirect(url.href);
  });
  app.get("/api/auth/github/callback",async c=>{
    const services=c.get("services"),origin=originFor(services);
    if(services.env.AUTH_MODE === "password")throw new ApiError(404,"NOT_FOUND","Not found");
    if(new URL(c.req.url).origin!==origin)throw new ApiError(403,"ORIGIN_REJECTED","OAuth callback must use the administration domain");
    const state=c.req.query("state")??"",cookie=getCookie(c,cookieName(services,true))??"";
    if(!state || !constantEqual(state,cookie))throw new ApiError(403,"OAUTH_STATE_FAILED","OAuth state is invalid");
    const stateRow=await services.store.get<{expiresAt:number}>("oauth-state",await sha256(state));
    if(!stateRow || stateRow.value.expiresAt<=services.now())throw new ApiError(403,"OAUTH_STATE_FAILED","OAuth state expired");
    await services.store.atomic([{kind:"oauth-state",id:stateRow.id,expectedVersion:stateRow.version,remove:true}]);
    deleteCookie(c,cookieName(services,true),options(services,0));
    const code=required(c.req.query("code"),"OAuth code");
    const response=await services.fetcher("https://github.com/login/oauth/access_token",{method:"POST",headers:{Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:required(services.env.GITHUB_OAUTH_CLIENT_ID,"GITHUB_OAUTH_CLIENT_ID"),client_secret:required(services.env.GITHUB_OAUTH_CLIENT_SECRET,"GITHUB_OAUTH_CLIENT_SECRET"),code,redirect_uri:`${origin}/api/auth/github/callback`}),signal:AbortSignal.timeout(15000),redirect:"error"});
    const token=await response.json() as {access_token?:string};
    if(!response.ok || !token.access_token)throw new ApiError(403,"OAUTH_FAILED","GitHub did not authorize this login");
    const userResponse=await services.fetcher("https://api.github.com/user",{headers:{Authorization:`Bearer ${token.access_token}`,Accept:"application/vnd.github+json","User-Agent":"Nocticur-Management"},signal:AbortSignal.timeout(15000),redirect:"error"});
    const user=await userResponse.json() as {id:number;login:string};
    if(!userResponse.ok || !Number.isSafeInteger(user.id) || String(user.id)!==required(services.env.ADMIN_GITHUB_USER_ID,"ADMIN_GITHUB_USER_ID"))throw new ApiError(403,"ADMIN_ONLY","This GitHub account is not the configured administrator");
    await issueSession(c,{id:user.id,login:user.login});return c.redirect(`${origin}${services.env.ADMIN_PATH === "/admin/" ? "/admin/" : "/"}`);
  });
  app.post("/api/auth/development",async c=>{
    const services=c.get("services");
    if(services.env.AUTH_MODE === "password" || services.env.ENVIRONMENT!=="development" || services.env.PLATFORM!=="local" || !services.env.DEV_AUTH_SECRET)throw new ApiError(404,"NOT_FOUND","Not found");
    assertWriteOrigin(c);await rateLimit(services,"development-login",10,60*1000);
    const body=await c.req.json();
    if(!constantEqual(String(body.secret??""),services.env.DEV_AUTH_SECRET))throw new ApiError(403,"LOGIN_FAILED","Invalid local development key");
    const session=await issueSession(c,{id:Number(services.env.ADMIN_GITHUB_USER_ID??"1"),login:"local-developer"});return c.json({user:session.user,csrf:session.csrf});
  });
  app.get("/api/me",authenticate,c=>c.json({user:c.get("session").user,csrf:c.get("session").csrf}));
  app.post("/api/auth/logout",authenticate,async c=>{
    const services=c.get("services"),token=getCookie(c,cookieName(services));
    if(token){const id=await sha256(token),row=await services.store.get("session",id);if(row)await services.store.atomic([{kind:"session",id,expectedVersion:row.version,remove:true}]);}
    deleteCookie(c,cookieName(services),options(services,0));return c.json({ok:true});
  });
}
