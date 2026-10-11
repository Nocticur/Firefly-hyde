/** Public feed text may not introduce HTML tags or escape link attributes. */
export function renderMomentsMarkdown(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/\n/g, "<br>")
		.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.*?)\*/g, "<em>$1</em>")
		.replace(
			/(https?:\/\/[^\s<]+)/g,
			'<a href="$1" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline;">$1</a>',
		);
}
