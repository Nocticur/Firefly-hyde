const response={"200":{description:"JSON result",content:{"application/json":{schema:{type:"object"}}}},"400":{description:"Validation error"},"401":{description:"Authentication required"},"403":{description:"Origin, CSRF or authorization failed"},"409":{description:"Optimistic version conflict; error.details.current contains the latest record"},"503":{description:"Persistent service or credential binding is missing"}};
const entries:Array<[string,string[],boolean,string]>=[
 ["/api/me",["get"],true,"Current numeric GitHub identity and CSRF token"],
 ["/api/dashboard",["get"],true,"Private dashboard counts and production state"],
 ["/api/auth/github",["get"],false,"Start GitHub OAuth at the fixed administration origin"],
 ["/api/auth/github/callback",["get"],false,"One-use OAuth state and numeric administrator binding"],
 ["/api/auth/logout",["post"],true,"Revoke the session"],
 ["/api/articles",["get","post"],true,"List private records or create an unpublished draft"],
 ["/api/articles/{id}",["get","put"],true,"Load or save exact Markdown/MDX source using version CAS"],
 ["/api/articles/{id}/history",["get"],true,"Immutable raw source history"],
 ["/api/articles/{id}/restore",["post"],true,"Restore a historical version without overwriting the current draft"],
 ["/api/settings",["get","put"],true,"Save a whitelist of setting fields as a private draft"],
 ["/api/navigation",["get","put"],true,"Nested navigation sorting with optimistic version checks"],
 ["/api/media",["get"],true,"Private owner-scoped media metadata"],
 ["/api/media/upload",["post"],true,"Authenticated bounded multipart upload"],
 ["/api/media/import",["post"],true,"Import HTTPS media from explicitly allowed public hosts"],
 ["/api/media/{id}",["patch"],true,"Save alt text and caption"],
 ["/api/media/{id}/content",["get"],true,"Authenticated private resource bytes"],
 ["/api/comments",["get"],true,"Admin comment list, including private email"],
 ["/api/comments/{id}/delete",["post"],true,"Soft delete while retaining the reply relationship"],
 ["/api/bans",["get","post"],true,"Create or list salted visitor bans"],
 ["/api/bans/{id}",["delete"],true,"Revoke a ban using version CAS"],
 ["/api/friends",["get"],true,"Applications, review and production notification state"],
 ["/api/friends/{id}/approve",["post"],true,"Approve privately and enqueue mail waiting for verified production"],
 ["/api/friends/{id}/reject",["post"],true,"Commit rejection and its mail outbox in one transaction"],
 ["/api/friends/sorting",["put"],true,"Atomically sort groups and applications"],
 ["/api/publications",["get","post"],true,"Freeze selected versions and create a persistent publication task"],
 ["/api/publications/{id}",["get"],true,"Durable publication state and target/production evidence"],
 ["/api/publications/{id}/reconcile",["post"],true,"Reconcile uncertain commits and deployments before retry"],
 ["/api/maintenance/tasks",["get","post"],true,"Persistent maintenance task queue"],
 ["/api/maintenance/tasks/{id}/retry",["post"],true,"Retry an eligible maintenance task"],
 ["/api/maintenance/backups",["get"],true,"Verified private backup metadata"],
 ["/api/maintenance/outbox",["get"],true,"Notification records and provider idempotency state"],
 ["/api/maintenance/import-baseline",["post"],true,"Import the configured repository's private baseline records without a Git commit"],
 ["/api/public/config",["get"],false,"Public Turnstile site key and feature readiness"],
 ["/api/public/comments",["get","post"],false,"Public plain-text comments; never returns email"],
 ["/api/public/friends",["get","post"],false,"Verified published friends or a private application"],
];
const paths:Record<string,unknown>={};
const string={type:"string"},version={type:"integer",minimum:0};
const articleInput={type:"object",required:["raw","path","slug"],properties:{raw:{type:"string",maxLength:2000000},path:{type:"string",description:"Markdown or MDX under src/content/posts"},slug:{type:"string",description:"Fixed slug; independent of title"},draft:{type:"boolean",default:true},version}};
const requestSchemas:Record<string,unknown>={
  "/api/articles":articleInput,"/api/articles/{id}":{...articleInput,required:["raw","path","slug","draft","version"]},
  "/api/articles/{id}/restore":{type:"object",required:["version","expectedVersion"],properties:{version,expectedVersion:version}},
  "/api/settings":{type:"object",required:["values","version"],properties:{version,values:{type:"object",additionalProperties:false,properties:Object.fromEntries(["title","subtitle","description","author","siteUrl","timezone","siteStartTime","avatar","homeCover","defaultCover","background","github","bilibili","qqGroup","email","signature"].map(x=>[x,string]).concat([["icons",{type:"object",additionalProperties:string}]] as any))}}},
  "/api/navigation":{type:"object",required:["items","version"],properties:{version,items:{type:"array",items:{$ref:"#/components/schemas/NavigationItem"}}}},
  "/api/public/comments":{type:"object",required:["articleId","name","text","email","turnstileToken"],properties:{articleId:string,parentId:{type:["string","null"]},name:{type:"string",maxLength:80},text:{type:"string",maxLength:5000,description:"Plain text only; HTML is never rendered"},email:{type:"string",format:"email"},turnstileToken:string}},
  "/api/public/friends":{type:"object",required:["name","url","description","email","turnstileToken"],properties:{name:string,url:{type:"string",format:"uri",description:"HTTPS URL"},avatar:string,description:string,email:{type:"string",format:"email"},message:string,turnstileToken:string}},
  "/api/comments/{id}/delete":{type:"object",required:["version"],properties:{version}},
  "/api/bans":{type:"object",properties:{email:{type:"string",format:"email"},commentId:string,reason:string},description:"One of email or commentId is required"},
  "/api/bans/{id}":{type:"object",required:["version"],properties:{version}},
  "/api/friends/{id}/approve":{type:"object",required:["version"],properties:{version,group:string,order:{type:"integer"}}},
  "/api/friends/{id}/reject":{type:"object",required:["version","reason"],properties:{version,reason:string}},
  "/api/friends/sorting":{type:"object",required:["items"],properties:{items:{type:"array",items:{type:"object",required:["id","version","group","order"],properties:{id:string,version,group:string,order:{type:"integer"}}}}}},
  "/api/publications":{type:"object",required:["articleIds","expectedVersions"],properties:{articleIds:{type:"array",items:string},expectedVersions:{type:"object",additionalProperties:version},settingsVersion:version,navigationVersion:version}},
  "/api/maintenance/tasks":{type:"object",required:["type"],properties:{type:{type:"string",enum:["backup","restore","verify-backup","check-updates","rebuild-index","clear-cache"]},payload:{type:"object",properties:{backupId:string,confirm:{type:"string",const:"RESTORE_PRIVATE_DATA"}},description:"Restore requires a backupId and explicit confirmation string"}}},
  "/api/maintenance/tasks/{id}/retry":{type:"object",required:["version"],properties:{version}},
};
for(const [path,methods,admin,summary] of entries){
  paths[path]=Object.fromEntries(methods.map(method=>[method,{
    summary,
    operationId:`${method}_${path.replace(/[^a-zA-Z0-9]/g,"_")}`,
    security:admin?[{sessionCookie:[],...(!["get","head"].includes(method)?{csrf:[]}:{})}]:[],
    ...((path.includes("{id}") || path==="/api/public/comments" && method==="get")?{parameters:path.includes("{id}")?[{name:"id",in:"path",required:true,schema:string}]:[{name:"articleId",in:"query",required:true,schema:string}]}:{}),
    ...(!["get","head"].includes(method)?{requestBody:{required:!path.endsWith("/reconcile")&&!path.endsWith("/logout"),content:path==="/api/media/upload"?{"multipart/form-data":{schema:{type:"object",required:["file"],properties:{file:{type:"string",format:"binary"},alt:string,caption:string}}}}:{"application/json":{schema:requestSchemas[path]??{type:"object"}}}}}:{}),
    responses:response,
  }]));
}
export const openApiDocument={
  openapi:"3.1.0",
  info:{title:"Nocticur Management API",version:"1.0.0",description:"Private drafts and explicit frozen publication; every admin mutation needs X-CSRF-Token. Lists use {items}, errors use {error:{code,message,details?}}."},
  servers:[{url:"/"}],
  components:{
    securitySchemes:{sessionCookie:{type:"apiKey",in:"cookie",name:"__Host-mgmt-session"},csrf:{type:"apiKey",in:"header",name:"X-CSRF-Token"}},
    schemas:{
      Error:{type:"object",required:["error"],properties:{error:{type:"object",required:["code","message"],properties:{code:{type:"string"},message:{type:"string"},details:{}}}}},
      ArticleInput:articleInput,
      NavigationItem:{type:"object",required:["id","name"],properties:{id:string,name:string,url:string,icon:string,order:{type:"integer"},external:{type:"boolean"},children:{type:"array",items:{$ref:"#/components/schemas/NavigationItem"}}}},
    },
  },
  paths,
};
