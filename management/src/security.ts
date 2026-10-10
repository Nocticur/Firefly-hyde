import type { Context } from "hono";
import { ApiError, required } from "./errors.ts";
import type { AppEnv, Services } from "./types.ts";

export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");
export async function sha256(text: string | ArrayBuffer): Promise<string> {
  const bytes=typeof text === "string" ? new TextEncoder().encode(text) : text;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),x=>x.toString(16).padStart(2,"0")).join("");
}
export function constantEqual(a:string,b:string) { if(a.length!==b.length)return false; let result=0; for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i); return result===0; }
export function originFor(services:Services):string {
  const url=new URL(required(services.env.ADMIN_ORIGIN,"ADMIN_ORIGIN"));
  if(url.pathname!=="/" || url.search || url.hash || url.username || url.password) throw new ApiError(503,"CONFIG_INVALID","ADMIN_ORIGIN must be an origin without a path");
  if(services.env.ENVIRONMENT!=="development" && url.protocol!=="https:")throw new ApiError(503,"CONFIG_INVALID","ADMIN_ORIGIN must use HTTPS");
  return url.origin;
}
export function assertWriteOrigin(c:Context<AppEnv>) {
  const services=c.get("services"); const origin=c.req.header("Origin");
  const referer=c.req.header("Referer");
  if(origin && origin!==originFor(services))throw new ApiError(403,"ORIGIN_REJECTED","Untrusted request origin");
  if(!origin && referer && new URL(referer).origin!==originFor(services))throw new ApiError(403,"ORIGIN_REJECTED","Untrusted request referrer");
}
export async function rateLimit(services:Services,key:string,limit:number,periodMs:number) {
  const id=await sha256(`${key}:${Math.floor(services.now()/periodMs)}`);
  for(let retry=0;retry<5;retry++){
    const row=await services.store.get<{count:number;expiresAt:number}>("rate",id);
    if((row?.value.count??0)>=limit)throw new ApiError(429,"RATE_LIMITED","Too many requests; try again later");
    const value={count:(row?.value.count??0)+1,expiresAt:services.now()+periodMs};
    try{if(row)await services.store.update("rate",id,row.version,value);else await services.store.create("rate",id,value);return;}catch(error){if(!(error instanceof ApiError && error.status===409))throw error;}
  }
  throw new ApiError(429,"RATE_LIMITED","Request rate is too high");
}
export async function visitorKey(c:Context<AppEnv>,email:string=""){
  const {env}=c.get("services");
  const secret=env.ENVIRONMENT==="development" ? (env.IP_HASH_SECRET ?? "local-only-development-hash") : required(env.IP_HASH_SECRET,"IP_HASH_SECRET");
  const ip=env.PLATFORM==="cloudflare" ? c.req.header("CF-Connecting-IP") : "local-development";
  return sha256(`${secret}:${email.trim().toLowerCase()}:${ip ?? "unknown"}`);
}
export async function verifyTurnstile(c:Context<AppEnv>,token:string){
  const services=c.get("services");
  if(services.env.ENVIRONMENT==="development" && services.env.PLATFORM==="local" && services.env.DEV_AUTH_SECRET && constantEqual(token,`development:${services.env.DEV_AUTH_SECRET}`))return;
  const secret=required(services.env.TURNSTILE_SECRET_KEY,"TURNSTILE_SECRET_KEY");
  const result=await services.fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret,response:token,idempotency_key:crypto.randomUUID()}),signal:AbortSignal.timeout(15000)});
  const verified=await result.json() as {success:boolean;hostname?:string};
  const expected=new URL(required(services.env.BLOG_ORIGIN,"BLOG_ORIGIN")).hostname;
  if(!result.ok || !verified.success || verified.hostname!==expected)throw new ApiError(403,"TURNSTILE_FAILED","Human verification failed");
}
export function safeExternalURL(input:string){
  let url:URL;try{url=new URL(input);}catch{throw new ApiError(400,"INVALID_URL","A valid HTTPS URL is required");}
  if(url.protocol!=="https:" || url.username || url.password)throw new ApiError(400,"INVALID_URL","A HTTPS URL without credentials is required");
  return url.href;
}
