import { ApiError, required } from "./errors.ts";
import { sha256 } from "./security.ts";
import type { BuildCheckEvidence,Services } from "./types.ts";

export type CommitFile = { path: string; content: string | null; expectedHash?: string | null };
export type ProductionEvidence = {
	verified: boolean;
	status: "waiting" | "failed" | "verified";
	reason: string;
	productionSha?: string;
	providerVersion?: string;
	manifest?: Record<string, unknown>;
	build?: BuildEvidence;
};
export type BuildEvidence = BuildCheckEvidence;

const fullSha = /^[a-f0-9]{40}$/i;
const encode = (value: string) => encodeURIComponent(value);
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const utf8 = new TextEncoder();

export function assertPublishingConfiguration(services: Services) {
	const env = services.env;
	if (env.ENVIRONMENT !== "production") throw new ApiError(403, "PRODUCTION_REQUIRED", "Preview and development environments cannot publish production content");
	for (const key of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_REPOSITORY", "BLOG_ORIGIN"] as const) required(env[key], key);
	if (!/^[\w.-]+\/[\w.-]+$/.test(String(env.GITHUB_REPOSITORY))) throw new ApiError(503, "INVALID_REPOSITORY", "GITHUB_REPOSITORY must be owner/repository");
	if (env.PLATFORM !== "cloudflare") throw new ApiError(503, "PLATFORM_REQUIRED", "Configure the production Cloudflare platform");
	for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "BLOG_WORKER_NAME"] as const) required(env[key], key);
	buildCheckConfiguration(services);
}
function buildCheckConfiguration(services:Services){
	const checkName=String(required(services.env.GITHUB_BUILD_CHECK_NAME,"GITHUB_BUILD_CHECK_NAME"));
	const appId=String(required(services.env.GITHUB_BUILD_CHECK_APP_ID,"GITHUB_BUILD_CHECK_APP_ID"));
	if(!checkName.trim()||checkName.length>200||/[\r\n\u0000]/.test(checkName)||!/^\d+$/.test(appId)||!Number.isSafeInteger(Number(appId))||Number(appId)<=0)throw new ApiError(503,"BUILD_CHECK_CONFIG_INVALID","Configure an exact GitHub Check name and its positive numeric App ID");
	return {checkName,appId:Number(appId)};
}
// GitHub's documented Check Runs API is the evidence source. The deployment
// settings explicitly identify the real Workers Builds check; no context or
// integration App ID is guessed from an old deployment or a timeout.
export async function verifyBuild(services:Services,targetSha:string,api:(path:string)=>Promise<any>):Promise<BuildEvidence>{
	if(!fullSha.test(targetSha))throw new ApiError(400,"INVALID_GIT_SHA","A full target Git SHA is required for a build check");
	const {checkName,appId}=buildCheckConfiguration(services),repository=String(required(services.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"));
	let latest:any=null,complete=false;
	for(let page=1;page<=5;page++){
		const response=await api(`/commits/${targetSha}/check-runs?filter=all&per_page=100&page=${page}`);
		if(!Array.isArray(response.check_runs)||!Number.isSafeInteger(response.total_count)||response.total_count<0)throw new ApiError(502,"BUILD_CHECK_RESPONSE_INVALID","GitHub returned invalid check-run evidence");
		for(const run of response.check_runs){
			if(run?.name!==checkName||run?.app?.id!==appId||run?.head_sha!==targetSha||run?.check_suite?.head_sha&&run.check_suite.head_sha!==targetSha)continue;
			if(!Number.isSafeInteger(run.id)||run.id<=0)throw new ApiError(502,"BUILD_CHECK_RESPONSE_INVALID","GitHub returned an invalid matching check-run ID");
			if(!latest||run.id>latest.id)latest=run;
		}
		if(response.check_runs.length<100||page*100>=response.total_count){complete=true;break;}
	}
	if(!complete)throw new ApiError(502,"BUILD_CHECKS_TRUNCATED","The configured check cannot be resolved conclusively from the check-run inventory");
	const evidence:BuildEvidence={status:"waiting",reason:"Waiting for the configured build check for the target Git SHA",repository,targetSha,checkName,appId};
	if(!latest)return evidence;
	Object.assign(evidence,{checkRunId:latest.id,checkStatus:latest.status,conclusion:latest.conclusion??null});
	if(latest.status!=="completed")return {...evidence,reason:`The target build check is ${latest.status??"unconfirmed"}`};
	if(["failure","timed_out","cancelled","action_required","startup_failure"].includes(latest.conclusion))return {...evidence,status:"failed",reason:`The configured target build check completed with ${latest.conclusion}`};
	if(latest.conclusion==="success")return {...evidence,status:"succeeded",reason:"The configured target build check succeeded; production verification is still required"};
	return {...evidence,reason:"The configured build check did not report a successful deployable build"};
}

// GitHub supplies RSA PKCS#1 keys. Wrap those in a PKCS#8 PrivateKeyInfo for
// WebCrypto; PKCS#8 keys work unchanged in Node.js Functions and Workers.
function privateKeyDer(pem: string) {
	const binary = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
	const key = Uint8Array.from(binary, char => char.charCodeAt(0));
	if (!pem.includes("BEGIN RSA PRIVATE KEY")) return key;
	const length = (n: number): number[] => {
		if (n < 128) return [n];
		const bytes: number[] = [];
		for (; n; n >>>= 8) bytes.unshift(n & 255);
		return [0x80 | bytes.length, ...bytes];
	};
	const prefix = [2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0];
	const body = [...prefix, 4, ...length(key.length), ...key];
	return new Uint8Array([48, ...length(body.length), ...body]);
}

async function githubJwt(services: Services) {
	const now = Math.floor(services.now() / 1000);
	const header = base64url(utf8.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const claims = base64url(utf8.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(required(services.env.GITHUB_APP_ID, "GITHUB_APP_ID")) })));
	const input = `${header}.${claims}`;
	let key: CryptoKey;
	try {
		const der = privateKeyDer(String(required(services.env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY")));
		key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	} catch { throw new ApiError(503, "INVALID_APP_KEY", "The configured GitHub App RSA private key cannot be imported"); }
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(input));
	return `${input}.${base64url(new Uint8Array(signature))}`;
}

async function requestJson(services: Services, url: string, init: RequestInit = {}) {
	let response: Response;
	try { response = await services.fetcher(url, { ...init, signal: AbortSignal.timeout(25_000), cache: "no-store" }); }
	catch { throw new ApiError(502, "UPSTREAM_UNCERTAIN", "The upstream request did not return a conclusive response"); }
	if (!response.ok) throw new ApiError(response.status === 409 || response.status === 422 ? 409 : 502, "UPSTREAM_REJECTED", `Upstream returned HTTP ${response.status}`, { upstreamStatus: response.status });
	try { return await response.json() as any; }
	catch { throw new ApiError(502, "UPSTREAM_INVALID", "Upstream returned an invalid JSON response"); }
}

export async function githubClient(services: Services) {
	const jwt = await githubJwt(services);
	const installation = encode(String(required(services.env.GITHUB_APP_INSTALLATION_ID, "GITHUB_APP_INSTALLATION_ID")));
	const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Nocticur-Publishing", "Content-Type": "application/json" };
	const access = await requestJson(services, `https://api.github.com/app/installations/${installation}/access_tokens`, { method: "POST", headers, body: JSON.stringify({ repositories: [String(services.env.GITHUB_REPOSITORY).split("/")[1]], permissions: { contents: "write", checks:"read" } }) });
	if (typeof access.token !== "string") throw new ApiError(502, "APP_TOKEN_INVALID", "GitHub did not issue an installation token");
	const repository = String(required(services.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"));
	const branch = String(services.env.GITHUB_BRANCH ?? "main");
	const root = `https://api.github.com/repos/${repository.split("/").map(encode).join("/")}`;
	const api = (path: string, init: RequestInit = {}) => requestJson(services, `${root}${path}`, { ...init, headers: { ...headers, Authorization: `Bearer ${access.token}`, ...init.headers } });
	const trees = new Map<string, Promise<any>>();
	const treeAt = (commitSha: string) => {
		let pending = trees.get(commitSha);
		if (!pending) {
			pending = (async () => {
				const commit = await api(`/git/commits/${commitSha}`);
				const tree = await api(`/git/trees/${encode(commit.tree.sha)}?recursive=1`);
				if (tree.truncated) throw new ApiError(502, "GIT_TREE_TRUNCATED", "The repository tree is truncated; use a smaller publication scope");
				return tree;
			})();
			trees.set(commitSha, pending);
		}
		return pending;
	};
	const head = async () => {
		const ref = await api(`/git/ref/heads/${encode(branch)}`);
		if (!fullSha.test(String(ref.object?.sha))) throw new ApiError(502, "INVALID_GIT_SHA", "GitHub returned an invalid branch SHA");
		return String(ref.object.sha);
	};
	const file = async (path: string, commitSha: string): Promise<string | null> => {
		const tree = await treeAt(commitSha);
		const item = tree.tree?.find((entry: any) => entry.path === path);
		if (!item) return null;
		if (item.type !== "blob" || item.mode === "120000") throw new ApiError(409, "UNSAFE_GIT_PATH", "Publication cannot overwrite a non-file or symbolic link", { path });
		const blob = await api(`/git/blobs/${item.sha}`);
		if (blob.encoding !== "base64") throw new ApiError(502, "GIT_BLOB_ENCODING", "GitHub did not return a base64 source blob");
		return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(String(blob.content).replace(/\s/g, "")), char => char.charCodeAt(0)));
	};
	const findNonce = async (nonce: string) => {
		// Search the live branch, never a disconnected commit object. A found nonce
		// resolves a lost PATCH response without issuing a new commit.
		for (let page = 1; page <= 5; page++) {
			const commits = await api(`/commits?sha=${encode(branch)}&per_page=100&page=${page}`);
			if (!Array.isArray(commits)) throw new ApiError(502, "GIT_COMMITS_INVALID", "GitHub returned an invalid commit list");
			const found = commits.find(item => String(item.commit?.message).split("\n").includes(`Publication-Nonce: ${nonce}`));
			if (found) return String(found.sha);
			if (commits.length < 100) break;
		}
		return null;
	};
	const updateRef = async (baseSha: string, targetSha: string) => {
		const current = await head();
		if (current === targetSha) return targetSha;
		if (current !== baseSha) throw new ApiError(409, "GIT_CONFLICT", "The publication branch changed; review its differences before publishing", { baseSha, currentSha: current, targetSha });
		const result = await api(`/git/refs/heads/${encode(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: targetSha, force: false }) });
		if (result.object?.sha !== targetSha) throw new ApiError(502, "REF_UPDATE_UNCERTAIN", "The branch update could not be confirmed");
		return targetSha;
	};
	const atomicCommit = async (input: { baseSha: string; files: CommitFile[]; nonce: string; createdAt: string; onPrepared: (sha: string) => Promise<void> }) => {
		if (!fullSha.test(input.baseSha)) throw new ApiError(400, "INVALID_GIT_SHA", "A full base Git SHA is required");
		if (await head() !== input.baseSha) throw new ApiError(409, "GIT_CONFLICT", "The publication branch changed before the commit was prepared");
		const base = await api(`/git/commits/${input.baseSha}`);
		const treeEntries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
		for (const change of input.files) {
			if (change.path.split("/").some(part => !part || part === "." || part === "..") || /[\\\u0000-\u001f]/.test(change.path)) throw new ApiError(400, "INVALID_GIT_PATH", "Invalid publication path");
			if (change.expectedHash !== undefined) {
				const current = await file(change.path, input.baseSha);
				const actualHash = current === null ? null : await sha256(current);
				if (actualHash !== change.expectedHash) throw new ApiError(409, "SOURCE_CONFLICT", "An article changed outside the frozen editing history", { path: change.path, expectedHash: change.expectedHash, actualHash, currentRaw: current });
			}
			if (change.content === null) treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
			else {
				const blob = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: change.content, encoding: "utf-8" }) });
				treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: String(blob.sha) });
			}
		}
		const tree = await api("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree: treeEntries }) });
		const identity = { name: "Nocticur", email: "nocticur@mourn.top", date: input.createdAt };
		const commit = await api("/git/commits", { method: "POST", body: JSON.stringify({ message: `content: publish frozen snapshot\n\nPublication-Nonce: ${input.nonce}`, tree: tree.sha, parents: [input.baseSha], author: identity, committer: identity }) });
		if (!fullSha.test(String(commit.sha))) throw new ApiError(502, "INVALID_GIT_SHA", "GitHub did not return a full commit SHA");
		// Persist the prepared SHA before the only externally visible mutation.
		await input.onPrepared(String(commit.sha));
		return updateRef(input.baseSha, String(commit.sha));
	};
	const buildStatus=(targetSha:string)=>verifyBuild(services,targetSha,path=>api(path));
	return { branch, repository, head, file, findNonce, updateRef, atomicCommit,buildStatus };
}

export async function verifyProduction(services: Services, targetSha: string, contentHash: string,git?:Awaited<ReturnType<typeof githubClient>>): Promise<ProductionEvidence> {
	const env = services.env;
	const origin = new URL(String(required(env.BLOG_ORIGIN, "BLOG_ORIGIN")));
	if (origin.protocol !== "https:") throw new ApiError(503, "INVALID_BLOG_ORIGIN", "The production blog origin must use HTTPS");
	buildCheckConfiguration(services);
	const build=await (git??await githubClient(services)).buildStatus(targetSha);
	if(build.status!=="succeeded")return {verified:false,status:build.status==="failed"?"failed":"waiting",reason:build.reason,build};
	let productionSha: string | undefined;
	let providerVersion: string;
	if (env.PLATFORM === "cloudflare") {
		const root = `https://api.cloudflare.com/client/v4/accounts/${encode(String(required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID")))}/workers/scripts/${encode(String(required(env.BLOG_WORKER_NAME, "BLOG_WORKER_NAME")))}`;
		const headers = { Authorization: `Bearer ${required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN")}` };
		const response = await requestJson(services, `${root}/deployments`, { headers });
		if (response.success === false) throw new ApiError(502, "CLOUDFLARE_REJECTED", "Cloudflare could not return production deployments");
		const deployments = response.result?.deployments ?? response.result;
		const current = Array.isArray(deployments) ? [...deployments].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0] : null;
		if (!current || !Array.isArray(current.versions)) throw new ApiError(502, "CLOUDFLARE_DEPLOYMENT_INVALID", "Cloudflare did not return a current production version");
		if (current.versions.length !== 1 || Number(current.versions[0].percentage) !== 100) return { verified: false, status: "waiting", reason: "Cloudflare is serving a weighted deployment; a complete version switch is required",build };
		providerVersion = String(current.versions[0].version_id);
		const version = await requestJson(services, `${root}/versions/${encode(providerVersion)}`, { headers });
		productionSha = version.result?.annotations?.["workers/tag"];
		if (!fullSha.test(String(productionSha))) throw new ApiError(503, "WORKER_GIT_TAG_REQUIRED", "Deploy the blog Worker with --tag set to the full Git commit SHA");
		if (productionSha !== targetSha) return { verified: false, status: "waiting", reason: "Cloudflare production has not switched to the target Git SHA", productionSha, providerVersion,build };
	} else throw new ApiError(503, "PLATFORM_REQUIRED", "Configure a production platform");
	const manifest = await requestJson(services, new URL("/release-manifest.json", origin).href, { headers: { "Cache-Control": "no-cache" }, redirect: "error" });
	const matchesProvider = manifest.workerVersion === providerVersion;
	if (manifest.schemaVersion !== 1 || manifest.dirty !== false || manifest.gitSha !== targetSha || manifest.repository !== env.GITHUB_REPOSITORY || manifest.contentHash !== contentHash || !matchesProvider) return { verified: false, status: "waiting", reason: "The production manifest does not match the clean Git snapshot, content hash and active provider version", productionSha, providerVersion, manifest,build };
	if (!Array.isArray(manifest.articles)) throw new ApiError(502, "MANIFEST_INVALID", "Production did not return its article inventory");
	const articles = [...manifest.articles].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(({ id, slug, sha256: hash }: any) => ({ id, slug, sha256: hash }));
	if (await sha256(JSON.stringify(articles)) !== contentHash) return { verified: false, status: "waiting", reason: "The production inventory does not hash to the frozen content manifest", productionSha, providerVersion, manifest,build };
	return { verified: true, status: "verified", reason: "Production Git SHA, provider version and content inventory agree", productionSha, providerVersion, manifest,build };
}

export async function dispatchPublicationTask(services: Services, id: string) {
	if (services.env.ENVIRONMENT !== "production") throw new ApiError(403, "PRODUCTION_REQUIRED", "Preview and development cannot dispatch production tasks");
	if (services.env.PLATFORM === "cloudflare") {
		await required(services.env.TASKS, "TASKS Queue binding").send({ type: "publication", publicationId: id });
		return;
	}
	throw new ApiError(503, "PLATFORM_REQUIRED", "Configure a durable publication transport");
}
