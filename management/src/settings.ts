import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "./errors.ts";
import type { AppEnv,NavigationItem } from "./types.ts";

const iconNames=["favicon.svg","favicon.ico","favicon-96x96.png","apple-touch-icon.png","web-app-manifest-192x192.png","web-app-manifest-512x512.png"];
const settings=z.object({
 title:z.string().max(200).optional(),subtitle:z.string().max(200).optional(),description:z.string().max(2000).optional(),author:z.string().max(200).optional(),
 siteUrl:z.string().url().optional(),timezone:z.string().max(80).optional(),siteStartTime:z.string().max(80).optional(),
 avatar:z.string().max(2048).optional(),homeCover:z.string().max(2048).optional(),defaultCover:z.string().max(2048).optional(),background:z.string().max(2048).optional(),
 github:z.string().max(2048).optional(),bilibili:z.string().max(2048).optional(),qqGroup:z.string().max(2048).optional(),email:z.string().email().optional(),signature:z.string().max(4000).optional(),
 icons:z.record(z.string(),z.string().max(2048)).refine(value=>Object.keys(value).every(x=>iconNames.includes(x)),"Only the six documented icon slots are accepted").optional(),
}).strict();
const navItem:z.ZodType<NavigationItem>=z.lazy(()=>z.object({id:z.string().min(1).max(120),name:z.string().min(1).max(120),url:z.string().max(2048).optional(),icon:z.string().max(150).optional(),order:z.number().int().optional(),external:z.boolean().optional(),children:z.array(navItem).max(40).optional()}).strict());
function validateNavigation(items:NavigationItem[],depth=0,ids=new Set<string>()){
  if(depth>3)throw new ApiError(400,"NAVIGATION_DEPTH","At most four navigation levels are supported");
  for(const item of items){if(ids.has(item.id))throw new ApiError(400,"NAVIGATION_DUPLICATE","Navigation IDs must be unique");ids.add(item.id);if(item.url && !/^(?:\/(?!\/)|https:\/\/|mailto:|#)/.test(item.url))throw new ApiError(400,"INVALID_NAVIGATION_URL","Unsafe navigation URL");if(item.children)validateNavigation(item.children,depth+1,ids);}
}
export function registerSettings(app:Hono<AppEnv>){
  app.get("/api/settings",async c=>{const row=await c.get("services").store.get<{values:Record<string,unknown>}>("settings","site");return c.json({values:row?.value.values ?? {},version:row?.version ?? 0});});
  app.put("/api/settings",async c=>{
    const input=z.object({values:settings,version:z.number().int().nonnegative()}).parse(await c.req.json());
    if(input.values.timezone){try{new Intl.DateTimeFormat("en",{timeZone:input.values.timezone});}catch{throw new ApiError(400,"INVALID_TIMEZONE","Use an IANA timezone");}}
    if(input.values.siteStartTime && Number.isNaN(Date.parse(input.values.siteStartTime)))throw new ApiError(400,"INVALID_DATE","Use an ISO date with an explicit timezone");
    for(const key of ["siteUrl","github","bilibili","qqGroup"] as const){const value=input.values[key];if(value && new URL(value).protocol!=="https:")throw new ApiError(400,"INVALID_URL","Public links must use HTTPS");}
    for(const key of ["avatar","homeCover","defaultCover","background"] as const){const value=input.values[key];if(value && !/^(?:\/(?!\/)|https:\/\/|media:)/.test(value))throw new ApiError(400,"INVALID_MEDIA_REFERENCE","Use an uploaded media ID, relative public path or HTTPS URL");}
    const store=c.get("services").store,current=await store.get<{values:Record<string,unknown>}>("settings","site");
    const value={...(current?.value??{}),values:{...(current?.value.values??{}),...input.values}};
    const next=current ? await store.update("settings","site",input.version,value) : (input.version===0 ? await store.create("settings","site",value) : (()=>{throw new ApiError(409,"VERSION_CONFLICT","Settings version changed");})());
    return c.json({values:next.value.values,version:next.version});
  });
  app.get("/api/navigation",async c=>{const row=await c.get("services").store.get<{items:NavigationItem[]}>("navigation","main");return c.json({items:row?.value.items ?? [],version:row?.version ?? 0});});
  app.put("/api/navigation",async c=>{
    const input=z.object({items:z.array(navItem).max(40),version:z.number().int().nonnegative()}).parse(await c.req.json());validateNavigation(input.items);
    const store=c.get("services").store,current=await store.get<{items:NavigationItem[]}>("navigation","main");
    const value={...(current?.value??{}),items:input.items};
    const next=current ? await store.update("navigation","main",input.version,value) : (input.version===0 ? await store.create("navigation","main",value) : (()=>{throw new ApiError(409,"VERSION_CONFLICT","Navigation version changed");})());
    return c.json({items:next.value.items,version:next.version});
  });
}
