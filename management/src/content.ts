import { parseDocument, isScalar } from "yaml";
import { z } from "zod";
import { normalizeArticleSlug } from "../../shared/article-slug.ts";
import type { Hono } from "hono";
import { ApiError } from "./errors.ts";
import { sha256 } from "./security.ts";
import type { Change } from "./store.ts";
import type { AppEnv, Article, History, Publication, Services, Stored } from "./types.ts";

export function normalizeSlug(value:string){
  try{return normalizeArticleSlug(value);}
  catch{throw new ApiError(400,"INVALID_SLUG","Use a literal fixed slug without URL encoding, traversal, query, fragment or control characters");}
}
export function articlePath(value:string){
  if(!value.startsWith("src/content/posts/") || !/\.(md|mdx)$/.test(value) || /[\\\u0000-\u001f]/u.test(value) || value.split("/").some(x=>x===".."||x==="."||!x))throw new ApiError(400,"INVALID_PATH","Use a Markdown or MDX path inside src/content/posts");
  return value;
}
function frontmatter(raw:string){
  const match=/^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if(!match)throw new ApiError(400,"FRONTMATTER_REQUIRED","An article must start with YAML front matter");
  const start=match[0].indexOf("\n")+1;
  const document=parseDocument(match[1],{keepSourceTokens:true,uniqueKeys:true});
  if(document.errors.length)throw new ApiError(400,"INVALID_FRONTMATTER","YAML front matter is invalid",{messages:document.errors.map(x=>x.message)});
  return {document,start,end:start+match[1].length,newline:raw.includes("\r\n")?"\r\n":"\n"};
}
export function articleTitle(raw:string){const {document}=frontmatter(raw);const title=document.get("title");return typeof title==="string"&&title.trim() ? title.trim() : "未命名文章";}
// Only the scalar ranges of owned fields are edited. Unknown YAML, comments, body,
// MDX and HTML remain byte-for-byte intact, including original newline style.
export function publishArticleRaw(article:Pick<Article,"raw"|"slug">){
  normalizeSlug(article.slug);
  const {document,start,end,newline}=frontmatter(article.raw);
  const edits:Array<{start:number;end:number;text:string}>=[];
  const patch=(key:string,value:string|boolean)=>{
    const node=document.get(key,true);
    if(node){if(!isScalar(node)||!node.range)throw new ApiError(400,"UNSAFE_FRONTMATTER",`${key} must be a scalar`);edits.push({start:start+node.range[0],end:start+node.range[1],text:JSON.stringify(value)});}
    else edits.push({start:end,end,text:`${newline}${key}: ${JSON.stringify(value)}`});
  };
  if(document.get("draft")===true)patch("draft",false);
  const slug=document.get("slug");
  if(typeof slug!=="string" || normalizeSlug(slug)!==article.slug)patch("slug",article.slug);
  let raw=article.raw;
  for(const edit of edits.sort((a,b)=>b.start-a.start))raw=raw.slice(0,edit.start)+edit.text+raw.slice(edit.end);
  return raw;
}
export const flattenArticle=(row:Stored<Article>)=>({...row.value,version:row.version});
function history(article:Article,version:number,reason:History["reason"]):History {return {...article,version,reason,createdAt:article.updatedAt};}
async function indexes(services:Services,next:Article,current?:Stored<Article>):Promise<Change[]>{
  const changes:Change[]=[];
  for(const [kind,key,old] of [["article-path",next.path,current?.value.path],["article-slug",next.slug,current?.value.slug]] as const){
    if(key===old)continue;
    const existing=await services.store.get<{articleId:string}>(kind,key);
    if(existing && existing.value.articleId!==next.id)throw new ApiError(409,"ARTICLE_EXISTS","Another article already uses this path or slug");
    if(!existing)changes.push({kind,id:key,value:{articleId:next.id},expectedVersion:null});
    if(old){const before=await services.store.get(kind,old);if(before)changes.push({kind,id:old,expectedVersion:before.version,remove:true});}
  }
  return changes;
}
export async function importBaseline(services:Services,baseline:{repository:string;branch:string;articles:Array<Partial<Article>&{id:string;path:string;slug:string;raw:string}>;settings?:Record<string,unknown>;navigation?:import("./types.ts").NavigationItem[]}){
  const marker=await services.store.get("baseline","initial");
  if(marker)return {imported:0,alreadyImported:true};
  if((await services.store.all("article")).length)throw new ApiError(409,"BASELINE_NOT_EMPTY","Import the baseline before creating articles");
  const now=new Date(services.now()).toISOString();const changes:Change[]=[];
  const slugs=new Set<string>(),paths=new Set<string>(),ids=new Set<string>();
  for(const source of baseline.articles){
    const slug=normalizeSlug(source.slug),path=articlePath(source.path);
    if(ids.has(source.id)||slugs.has(slug)||paths.has(path))throw new ApiError(400,"BASELINE_DUPLICATE","Baseline IDs, paths and slugs must be unique");
    ids.add(source.id);slugs.add(slug);paths.add(path);
    const draft=source.draft===true;
    const article:Article={id:source.id,path,slug,raw:source.raw,title:articleTitle(source.raw),draft,createdAt:now,updatedAt:now,redirects:[],...(!draft?{publishedVersion:1,publishedSlug:slug,publishedPath:path,publishedHash:await sha256(source.raw)}:{})};
    changes.push({kind:"article",id:article.id,value:article,expectedVersion:null},{kind:"history",id:`${article.id}:1`,value:history(article,1,"import"),expectedVersion:null},{kind:"article-path",id:path,value:{articleId:article.id},expectedVersion:null},{kind:"article-slug",id:slug,value:{articleId:article.id},expectedVersion:null});
  }
  // D1 has a bound on batch statements; the first import is guarded by a unique
  // marker and all 16 baseline records, indexes and histories share one transaction.
  if(baseline.settings)changes.push({kind:"settings",id:"site",value:{values:baseline.settings},expectedVersion:null},{kind:"published-settings",id:"site",value:{values:baseline.settings,version:1},expectedVersion:null});
  if(baseline.navigation)changes.push({kind:"navigation",id:"main",value:{items:baseline.navigation},expectedVersion:null},{kind:"published-navigation",id:"main",value:{items:baseline.navigation,version:1},expectedVersion:null});
  changes.push({kind:"baseline",id:"initial",expectedVersion:null,value:{repository:baseline.repository,branch:baseline.branch,count:baseline.articles.length,createdAt:now,registry:baseline.articles.map(({id,path,slug})=>({id,path,slug}))}});
  await services.store.atomic(changes);return {imported:baseline.articles.length,alreadyImported:false};
}
const articleInput=z.object({raw:z.string().max(2_000_000),path:z.string().max(500),slug:z.string().max(200),draft:z.boolean().default(true)});
export function registerArticles(app:Hono<AppEnv>){
  app.get("/api/articles",async c=>c.json({items:(await c.get("services").store.all<Article>("article")).map(flattenArticle)}));
  app.post("/api/articles",async c=>{
    const services=c.get("services"),input=articleInput.parse(await c.req.json());
    const now=new Date(services.now()).toISOString();
    const article:Article={id:crypto.randomUUID(),path:articlePath(input.path),slug:normalizeSlug(input.slug),raw:input.raw,title:articleTitle(input.raw),draft:true,createdAt:now,updatedAt:now,redirects:[]};
    const changes=await indexes(services,article);
    await services.store.atomic([{kind:"article",id:article.id,value:article,expectedVersion:null},{kind:"history",id:`${article.id}:1`,value:history(article,1,"create"),expectedVersion:null},...changes]);
    return c.json({...article,version:1},201);
  });
  app.get("/api/articles/:id",async c=>{
    const row=await c.get("services").store.get<Article>("article",c.req.param("id"));if(!row)throw new ApiError(404,"ARTICLE_NOT_FOUND","Article not found");return c.json(flattenArticle(row));
  });
  app.put("/api/articles/:id",async c=>{
    const services=c.get("services"),input=articleInput.extend({version:z.number().int().positive()}).parse(await c.req.json());
    const current=await services.store.get<Article>("article",c.req.param("id"));if(!current)throw new ApiError(404,"ARTICLE_NOT_FOUND","Article not found");
    if(input.version!==current.version)throw new ApiError(409,"VERSION_CONFLICT","The draft changed; review the current version",{current:flattenArticle(current)});
    const slug=normalizeSlug(input.slug);
    const article:Article={...current.value,raw:input.raw,path:articlePath(input.path),slug,title:articleTitle(input.raw),draft:input.draft,updatedAt:new Date(services.now()).toISOString(),redirects:[...new Set([...current.value.redirects,...(slug!==current.value.slug && current.value.publishedVersion?[current.value.publishedSlug ?? current.value.slug]:[])])]};
    const changes=await indexes(services,article,current);
    await services.store.atomic([{kind:"article",id:article.id,value:article,expectedVersion:input.version},{kind:"history",id:`${article.id}:${input.version+1}`,value:history(article,input.version+1,"save"),expectedVersion:null},...changes]);
    return c.json({...article,version:input.version+1});
  });
  app.get("/api/articles/:id/history",async c=>{
    const rows=await c.get("services").store.all<History>("history");return c.json({items:rows.filter(x=>x.value.id===c.req.param("id")).map(x=>x.value).sort((a,b)=>b.version-a.version)});
  });
  app.post("/api/articles/:id/restore",async c=>{
    const services=c.get("services"),input=z.object({version:z.number().int().positive(),expectedVersion:z.number().int().positive()}).parse(await c.req.json());
    const current=await services.store.get<Article>("article",c.req.param("id")),snapshot=await services.store.get<History>("history",`${c.req.param("id")}:${input.version}`);
    if(!current||!snapshot)throw new ApiError(404,"HISTORY_NOT_FOUND","Article version not found");
    if(current.version!==input.expectedVersion)throw new ApiError(409,"VERSION_CONFLICT","The current draft was saved after this page loaded",{current:flattenArticle(current)});
    const next:Article={...current.value,raw:snapshot.value.raw,path:articlePath(snapshot.value.path),slug:normalizeSlug(snapshot.value.slug),title:snapshot.value.title,draft:snapshot.value.draft,updatedAt:new Date(services.now()).toISOString(),redirects:[...new Set([...current.value.redirects,...(snapshot.value.slug!==current.value.slug&&current.value.publishedVersion?[current.value.publishedSlug ?? current.value.slug]:[])])]};
    const changes=await indexes(services,next,current);
    await services.store.atomic([{kind:"article",id:next.id,value:next,expectedVersion:current.version},{kind:"history",id:`${next.id}:${current.version+1}`,value:history(next,current.version+1,"restore"),expectedVersion:null},...changes]);
    return c.json({...next,version:current.version+1});
  });
}
export function publicationFiles(publication:Publication):Array<{path:string;content:string|null}>{
  for(const article of publication.snapshot){articlePath(article.path);normalizeSlug(article.slug);for(const old of article.redirects)normalizeSlug(old);}
  for(const identity of publication.registry??[]){articlePath(identity.path);normalizeSlug(identity.slug);}
  const json=(value:unknown)=>JSON.stringify(value,null,2)+"\n";
  const files:Array<{path:string;content:string|null}>=publication.snapshot.map(article=>({path:article.path,content:article.raw}));
  const map=new Map((publication.registry??[]).map(x=>[x.id,x]));for(const {id,path,slug} of publication.snapshot){const old=map.get(id);if(old && old.path!==path)files.push({path:old.path,content:null});map.set(id,{id,path,slug});}
  const registry={schemaVersion:1,repository:publication.repository,articles:[...map.values()].sort((a,b)=>a.id.localeCompare(b.id))};
  files.push({path:"src/constants/article-ids.json",content:json(registry)});
  if(publication.settings)files.push({path:"src/constants/managed-settings.json",content:json(publication.settings.values)});
  if(publication.navigation)files.push({path:"src/constants/managed-navigation.json",content:json(publication.navigation.items)});
  files.push({path:"src/constants/managed-friends.json",content:json(publication.friends.filter(x=>x.status==="approved").map(({id,name,url,avatar,description,group,order})=>({id,name,url,avatar,description,group,order})))});
  const redirects:Record<string,string>={};for(const article of publication.snapshot)for(const old of article.redirects)if(old!==article.slug)redirects[`/posts/${old}/`]=`/posts/${article.slug}/`;
  files.push({path:"src/constants/managed-redirects.json",content:json(redirects)});
  return files;
}
