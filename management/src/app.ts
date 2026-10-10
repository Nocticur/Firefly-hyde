import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { ApiError } from "./errors.ts";
import { authenticate,registerAuth } from "./auth.ts";
import { registerArticles } from "./content.ts";
import { registerSettings } from "./settings.ts";
import { registerInteractions,registerPublicInteractions } from "./interactions.ts";
import { registerMedia } from "./media.ts";
import { registerPublishing } from "./publishing.ts";
import { registerMaintenance,runMaintenance } from "./maintenance.ts";
import { createServices,productionRequirements } from "./runtime.ts";
import { openApiDocument } from "./openapi.ts";
import type { AppEnv,Article,Comment,Friend,Publication,Services,SiteLock,Task } from "./types.ts";

export function createApp(services?:Services){
  const app=new Hono<AppEnv>();
  app.use("/api/*",bodyLimit({maxSize:12*1024*1024,onError:c=>c.json({error:{code:"PAYLOAD_TOO_LARGE",message:"Request exceeds the upload limit"}},413)}));
  app.use("/api/*",async(c,next)=>{
    c.header("Cache-Control","no-store");c.header("CDN-Cache-Control","no-store");c.header("X-Content-Type-Options","nosniff");c.header("Referrer-Policy","same-origin");
    const svc=services??await createServices(c.env);c.set("services",svc);
    if(!["GET","HEAD","OPTIONS"].includes(c.req.method)){
      const gate=await svc.store.get<SiteLock>("publish-lock","site");
      if(gate?.value.mode==="restore")throw new ApiError(409,"MAINTENANCE_ACTIVE","Private data restoration is in progress; retry after it completes");
      const restoring=await svc.store.get<{expiresAt:number}>("lease","site-restore");
      if(restoring&&restoring.value.expiresAt>svc.now())throw new ApiError(409,"MAINTENANCE_ACTIVE","Private data restoration is in progress; retry after it completes");
    }
    const origin=c.req.header("Origin"),publicRoute=c.req.path.startsWith("/api/public/");
    if(publicRoute){
      if(origin && origin!==svc.env.BLOG_ORIGIN && origin!==svc.env.ADMIN_ORIGIN)throw new ApiError(403,"ORIGIN_REJECTED","Untrusted public request origin");
      if(origin){c.header("Access-Control-Allow-Origin",origin);c.header("Vary","Origin");}
      if(c.req.method==="OPTIONS"){c.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");c.header("Access-Control-Allow-Headers","Content-Type");return c.body(null,204);}
    }
    await next();
  });
  app.get("/api/health",c=>{const svc=c.get("services"),missing=productionRequirements(svc.env);return c.json({ok:svc.env.ENVIRONMENT==="development"||missing.length===0,environment:svc.env.ENVIRONMENT,productionReady:svc.env.ENVIRONMENT==="production"&&missing.length===0,missing},svc.env.ENVIRONMENT==="production"&&missing.length?503:200);});
  app.get("/api/openapi.json",c=>c.json(openApiDocument));
  registerAuth(app);registerPublicInteractions(app);
  app.use("/api/*",async(c,next)=>{
    if(c.req.path.startsWith("/api/public/") || c.req.path.startsWith("/api/auth/") || ["/api/health","/api/me","/api/openapi.json"].includes(c.req.path))return next();
    return authenticate(c,next);
  });
  app.get("/api/dashboard",async c=>{
    const services=c.get("services");const [articles,comments,friends,tasks,publications]=await Promise.all([services.store.all<Article>("article"),services.store.all<Comment>("comment"),services.store.all<Friend>("friend"),services.store.all<Task>("task"),services.store.all<Publication>("publication")]);
    const current=publications.find(x=>x.value.status==="succeeded")?.value,latest=publications[0]?.value;
    return c.json({articles:articles.length,publicArticles:articles.filter(x=>x.value.publishedVersion).length,comments:comments.filter(x=>!x.value.deleted).length,pendingFriends:friends.filter(x=>x.value.status==="pending").length,failedTasks:tasks.filter(x=>x.value.status==="failed").length,targetSha:latest?.targetSha??null,productionSha:current?.productionSha??null,recentComments:comments.slice(0,5).map(x=>({...x.value,version:x.version})),pendingFriendItems:friends.filter(x=>x.value.status==="pending").slice(0,5).map(x=>({...x.value,version:x.version})),publications:publications.slice(0,5).map(x=>({...x.value,version:x.version}))});
  });
  registerArticles(app);registerSettings(app);registerInteractions(app);registerMedia(app);registerPublishing(app);registerMaintenance(app);
  app.notFound(c=>c.json({error:{code:"NOT_FOUND",message:"API route not found"}},404));
  app.onError((error,c)=>{
    if(error instanceof ApiError)return c.json({error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}},error.status as any);
    if(error instanceof ZodError)return c.json({error:{code:"INVALID_REQUEST",message:"Request validation failed",details:error.issues}},400);
    if(error instanceof SyntaxError)return c.json({error:{code:"INVALID_JSON",message:"Request JSON is invalid"}},400);
    // Provider error bodies can contain credentials or private content. Return
    // a stable error without serializing the exception or injected environment.
    return c.json({error:{code:"INTERNAL_ERROR",message:"The operation could not be completed"}},500);
  });
  return app;
}
export const app=createApp();
