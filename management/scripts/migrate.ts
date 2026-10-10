import { spawn } from "node:child_process";
const remote=process.argv.includes("--remote"),local=process.argv.includes("--local");
if(remote===local)throw new Error("Select --local or --remote; the remote database_id must already be configured.");
const child=spawn("pnpm",["exec","wrangler","d1","migrations","apply","DB",...(remote?["--remote","--env","production"]:["--local"])],{stdio:"inherit",shell:false});
const code=await new Promise<number>((resolve,reject)=>{child.on("error",reject);child.on("exit",code=>resolve(code??1));});process.exitCode=code;
