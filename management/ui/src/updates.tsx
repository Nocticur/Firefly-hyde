import { Tag, Time } from "./shared";

interface ComponentUpdate {
	component: string; name: string; repository: string; currentVersion: string;
	status: string; latestVersion?: string; commitsAhead?: number; commitsBehind?: number;
	compareUrl?: string; message?: string;
}
interface UpdateCheck { schemaVersion: 1; checkedAt: string; complete: boolean; components: ComponentUpdate[] }
const labels: Record<string, string> = {
	"up-to-date": "已是最新", "update-available": "有可用更新", ahead: "本地版本较新",
	diverged: "提交历史已分叉", unavailable: "未能核验",
};

export function UpdateResult({ value }: { value: unknown }) {
	if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("components" in value) || !Array.isArray(value.components)) {
		return <pre className="source-preview">{JSON.stringify(value, null, 2)}</pre>;
	}
	const result = value as UpdateCheck;
	return <section aria-label="上游版本比较">
		<p>检查时间：<Time value={result.checkedAt}/></p>
		{!result.complete && <div className="notice danger">部分上游未能核验，可查看原因后重试。</div>}
		<div className="table-scroll"><table><thead><tr><th>组件 / 来源</th><th>当前版本</th><th>上游版本</th><th>比较结果</th></tr></thead><tbody>{result.components.map((component) => <tr key={component.component}>
			<td>{component.name}<small className="block muted">{component.repository}</small></td>
			<td><code>{component.currentVersion}</code></td><td><code>{component.latestVersion ?? "尚未核验"}</code></td>
			<td><Tag tone={component.status === "up-to-date" ? "green" : component.status === "unavailable" ? "red" : "amber"}>{labels[component.status] ?? component.status}</Tag>
				{component.commitsAhead !== undefined && <small className="block">上游新增 {component.commitsAhead} 个提交{component.commitsBehind ? `，另有 ${component.commitsBehind} 个基线提交不在上游` : ""}</small>}
				{component.message && <small className="danger-text block">{component.message}</small>}
				{component.compareUrl?.startsWith("https://github.com/") && <a className="block" href={component.compareUrl} target="_blank" rel="noreferrer">查看提交差异 ↗</a>}
			</td>
		</tr>)}</tbody></table></div>
		<p className="notice">检查只读取版本与提交差异。主题比较基于已合入的上游提交；后台比较本站仓库的版本号。更新需人工审查并合并。</p>
	</section>;
}
