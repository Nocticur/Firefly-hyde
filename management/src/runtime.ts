import { d1Database } from "./database.ts";
import { ApiError,required } from "./errors.ts";
import { RecordStore } from "./store.ts";
import type { Bindings,Services } from "./types.ts";

const cache=new WeakMap<object,Promise<Services>>();
export function createServices(env:Bindings):Promise<Services>{
  let services=cache.get(env);if(services)return services;
  services=(async()=>{
    if(env.PLATFORM!=="cloudflare")throw new ApiError(503,"CONFIG_REQUIRED","Select the Cloudflare persistent adapter; local development is started with the Node entry");
    const db=d1Database(required(env.DB,"DB") as Parameters<typeof d1Database>[0]);
    const store=new RecordStore(db);await store.migrate();return {store,env,fetcher:fetch,now:Date.now};
  })();cache.set(env,services);services.catch(()=>cache.delete(env));return services;
}
export const productionRequirements=(env:Bindings)=>{
  const names=["ADMIN_ORIGIN","BLOG_ORIGIN","ADMIN_GITHUB_USER_ID","GITHUB_OAUTH_CLIENT_ID","GITHUB_OAUTH_CLIENT_SECRET","GITHUB_APP_ID","GITHUB_APP_INSTALLATION_ID","GITHUB_APP_PRIVATE_KEY","GITHUB_REPOSITORY","GITHUB_BRANCH","GITHUB_BUILD_CHECK_NAME","GITHUB_BUILD_CHECK_APP_ID","TURNSTILE_SECRET_KEY","TURNSTILE_SITE_KEY","IP_HASH_SECRET","RESEND_API_KEY","MAIL_FROM","MEDIA_ORIGIN"];
  if(env.PLATFORM==="cloudflare")names.push("DB","PRIVATE_MEDIA","PUBLIC_MEDIA","TASKS","CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_API_TOKEN","BLOG_WORKER_NAME");
  else names.push("PLATFORM");
  return names.filter(name=>!env[name]);
};
