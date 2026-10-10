import type { Hono } from "hono";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ApiError,required } from "./errors.ts";
import { rateLimit,safeExternalURL,sha256,verifyTurnstile,visitorKey } from "./security.ts";
import type { Change } from "./store.ts";
import type { AppEnv,Article,Comment,Friend,Services } from "./types.ts";

const emailSchema=z.string().email().max(320);
const publicComment=(item:Comment)=>({id:item.id,articleId:item.articleId,parentId:item.parentId,name:item.deleted?"":item.name,text:item.deleted?"[已删除]":item.text,deleted:item.deleted,createdAt:item.createdAt});
const publicFriend=({id,name,url,avatar,description,group,order}:Friend)=>({id,name,url,avatar,description,group,order});
async function emailKey(services:Services,email:string){const secret=services.env.ENVIRONMENT==="development" ? services.env.IP_HASH_SECRET??"local-only" : required(services.env.IP_HASH_SECRET,"IP_HASH_SECRET");return sha256(`${secret}:email:${email.trim().toLowerCase()}`);}
async function publicArticle(services:Services,id:string){
  const row=await services.store.get<Article>("article",id);if(!row?.value.publishedVersion)throw new ApiError(404,"ARTICLE_NOT_PUBLISHED","This article is not public");
  const published=await services.store.get<{raw:string}>("history",`${id}:${row.value.publishedVersion}`);
  const yaml=/^---\r?\n([\s\S]*?)\r?\n---/.exec(published?.value.raw??row.value.raw)?.[1];
  if(yaml){const document=parseDocument(yaml);if(document.get("comment")===false||document.get("comments")===false)throw new ApiError(403,"COMMENTS_DISABLED","Comments are disabled for this article");}
}
export function registerPublicInteractions(app:Hono<AppEnv>){
  app.get("/api/public/config",c=>{const {env}=c.get("services");return c.json({turnstileSiteKey:env.TURNSTILE_SITE_KEY??null,commentsEnabled:Boolean(env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET_KEY),friendsEnabled:Boolean(env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET_KEY)});});
  app.get("/api/public/comments",async c=>{
    const services=c.get("services"),articleId=z.string().min(1).parse(c.req.query("articleId"));await publicArticle(services,articleId);
    const items=(await services.store.all<Comment>("comment")).filter(x=>x.value.articleId===articleId).map(x=>publicComment(x.value)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));return c.json({items});
  });
  app.post("/api/public/comments",async c=>{
    const input=z.object({articleId:z.string().min(1),parentId:z.string().nullable().optional(),name:z.string().trim().min(1).max(80),text:z.string().trim().min(1).max(5000),email:emailSchema,turnstileToken:z.string().min(1).max(4096)}).strict().parse(await c.req.json());
    const services=c.get("services");await publicArticle(services,input.articleId);await verifyTurnstile(c,input.turnstileToken);
    const ip=await visitorKey(c);await rateLimit(services,`comment:${ip}`,5,60*1000);await rateLimit(services,`comment-day:${ip}`,50,24*60*60*1000);
    const authorKey=await emailKey(services,input.email);if(await services.store.get("ban",authorKey))throw new ApiError(403,"COMMENT_BANNED","This visitor is banned from commenting");
    if(input.parentId){const parent=await services.store.get<Comment>("comment",input.parentId);if(!parent || parent.value.articleId!==input.articleId)throw new ApiError(400,"INVALID_PARENT","Reply must belong to this article");}
    const now=new Date(services.now()).toISOString(),item:Comment={id:crypto.randomUUID(),articleId:input.articleId,parentId:input.parentId??null,name:input.name,text:input.text,email:input.email.trim().toLowerCase(),authorKey,deleted:false,createdAt:now,updatedAt:now};
    await services.store.create("comment",item.id,item);return c.json({item:publicComment(item)},201);
  });
  app.get("/api/public/friends",async c=>{const items=(await c.get("services").store.all<Friend>("public-friend")).map(x=>publicFriend(x.value)).sort((a,b)=>a.group.localeCompare(b.group)||a.order-b.order||a.id.localeCompare(b.id));return c.json({items});});
  app.post("/api/public/friends",async c=>{
    const input=z.object({name:z.string().trim().min(1).max(100),url:z.string().url().max(2048),avatar:z.string().max(2048).default(""),description:z.string().trim().max(1000),email:emailSchema,message:z.string().max(2000).optional(),turnstileToken:z.string().min(1).max(4096)}).strict().parse(await c.req.json());
    const services=c.get("services");await verifyTurnstile(c,input.turnstileToken);const ip=await visitorKey(c);await rateLimit(services,`friend:${ip}`,3,60*60*1000);
    const url=safeExternalURL(input.url),avatar=input.avatar?safeExternalURL(input.avatar):"";
    const key=await sha256(url),claim=await services.store.get("friend-url",key);if(claim)throw new ApiError(409,"FRIEND_EXISTS","This site already has an application");
    const item:Friend={id:crypto.randomUUID(),name:input.name,url,avatar,description:input.description,email:input.email.trim().toLowerCase(),message:input.message,status:"pending",reason:"",group:"友链",order:0,live:false,notificationStatus:"waiting",createdAt:new Date(services.now()).toISOString()};
    await services.store.atomic([{kind:"friend",id:item.id,value:item,expectedVersion:null},{kind:"friend-url",id:key,value:{friendId:item.id},expectedVersion:null}]);return c.json({id:item.id,status:item.status},202);
  });
}
export function registerInteractions(app:Hono<AppEnv>){
  app.get("/api/comments",async c=>{const services=c.get("services"),bans=new Set((await services.store.all("ban")).map(x=>x.id));return c.json({items:(await services.store.all<Comment>("comment")).map(x=>({...x.value,version:x.version,banned:bans.has(x.value.authorKey)}))});});
  app.post("/api/comments/:id/delete",async c=>{const input=z.object({version:z.number().int().positive()}).parse(await c.req.json()),services=c.get("services"),row=await services.store.get<Comment>("comment",c.req.param("id"));if(!row)throw new ApiError(404,"COMMENT_NOT_FOUND","Comment not found");const value={...row.value,deleted:true,text:"",updatedAt:new Date(services.now()).toISOString()};const next=await services.store.update("comment",row.id,input.version,value);return c.json({...next.value,version:next.version});});
  app.get("/api/bans",async c=>c.json({items:(await c.get("services").store.all("ban")).map(x=>({...x.value as object,id:x.id,version:x.version}))}));
  app.post("/api/bans",async c=>{
    const input=z.object({email:emailSchema.optional(),commentId:z.string().optional(),reason:z.string().max(1000).default("")}).parse(await c.req.json()),services=c.get("services");
    const comment=input.commentId?await services.store.get<Comment>("comment",input.commentId):null,email=input.email??comment?.value.email;if(!email)throw new ApiError(400,"EMAIL_REQUIRED","An email or comment ID is required");
    const id=await emailKey(services,email),existing=await services.store.get("ban",id);if(existing)return c.json({...existing.value as object,id,version:existing.version});
    const value={email,reason:input.reason,createdAt:new Date(services.now()).toISOString()};await services.store.create("ban",id,value);return c.json({...value,id,version:1},201);
  });
  app.delete("/api/bans/:id",async c=>{const input=z.object({version:z.number().int().positive()}).parse(await c.req.json());await c.get("services").store.atomic([{kind:"ban",id:c.req.param("id"),expectedVersion:input.version,remove:true}]);return c.json({ok:true});});
  app.get("/api/friends",async c=>c.json({items:(await c.get("services").store.all<Friend>("friend")).map(x=>({...x.value,version:x.version}))}));
  const approveOrReject=(approved:boolean)=>async(c:any)=>{
    const input=z.object({version:z.number().int().positive(),reason:z.string().max(2000).default(""),group:z.string().max(100).default("友链"),order:z.number().int().default(0)}).parse(await c.req.json());
    if(!approved&&!input.reason.trim())throw new ApiError(400,"REASON_REQUIRED","A rejection reason is required");
    const services:Services=c.get("services"),row=await services.store.get<Friend>("friend",c.req.param("id"));if(!row)throw new ApiError(404,"FRIEND_NOT_FOUND","Friend not found");
    if(row.value.status!=="pending")throw new ApiError(409,"ALREADY_REVIEWED","This application was already reviewed");
    const status=approved?"approved":"rejected",value:Friend={...row.value,status,reason:input.reason,group:input.group,order:input.order,live:false,notificationStatus:"waiting"};
    const key=`friend:${row.id}:${status}`,now=new Date(services.now()).toISOString();
    await services.store.atomic([{kind:"friend",id:row.id,value,expectedVersion:input.version},{kind:"outbox",id:key,expectedVersion:null,value:{id:key,notificationKey:key,friendId:row.id,type:`friend-${status}`,recipient:row.value.email,reason:input.reason,status:approved?"waiting":"pending",attempts:0,createdAt:now,updatedAt:now}}]);
    return c.json({...value,version:input.version+1});
  };
  app.post("/api/friends/:id/approve",approveOrReject(true));app.post("/api/friends/:id/reject",approveOrReject(false));
  app.put("/api/friends/sorting",async c=>{
    const input=z.object({items:z.array(z.object({id:z.string(),version:z.number().int().positive(),group:z.string().max(100),order:z.number().int()})).max(500)}).parse(await c.req.json());
    const services=c.get("services"),changes:Change[]=[];
    for(const item of input.items){const row=await services.store.get<Friend>("friend",item.id);if(!row)throw new ApiError(404,"FRIEND_NOT_FOUND","Friend not found");changes.push({kind:"friend",id:item.id,expectedVersion:item.version,value:{...row.value,group:item.group,order:item.order}});}
    await services.store.atomic(changes);return c.json({ok:true});
  });
}
