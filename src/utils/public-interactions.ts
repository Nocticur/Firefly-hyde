export type PublicConfig = {
	turnstileSiteKey: string | null;
	commentsEnabled: boolean;
	friendsEnabled: boolean;
};

type TurnstileApi = {
	render(element: HTMLElement, options: Record<string, unknown>): string;
	reset(id: string): void;
	remove(id: string): void;
};

let turnstilePromise: Promise<TurnstileApi> | undefined;

export async function publicRequest<T>(
	path: string,
	options: RequestInit = {},
): Promise<T> {
	if (!path.startsWith("/api/public/")) throw new Error("无效的请求");
	const response = await fetch(path, {
		...options,
		credentials: "omit",
		cache: "no-store",
		headers: { "Content-Type": "application/json", ...options.headers },
	});
	const data = await response.json();
	if (!response.ok) {
		throw new Error(
			data?.error?.message || data?.message || "暂时无法提交，请稍后再试",
		);
	}
	return data as T;
}

function loadTurnstile(): Promise<TurnstileApi> {
	const current = (window as Window & { turnstile?: TurnstileApi }).turnstile;
	if (current) return Promise.resolve(current);
	if (turnstilePromise) return turnstilePromise;
	turnstilePromise = new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src =
			"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		script.onload = () => {
			const api = (window as Window & { turnstile?: TurnstileApi }).turnstile;
			if (api) resolve(api);
			else reject(new Error("验证暂不可用，请稍后再试"));
		};
		script.onerror = () => {
			script.remove();
			turnstilePromise = undefined;
			reject(new Error("验证暂不可用，请稍后再试"));
		};
		document.head.append(script);
	});
	return turnstilePromise;
}

export async function mountChallenge(
	element: HTMLElement,
	sitekey: string,
	onToken: (token: string) => void,
	signal: AbortSignal,
): Promise<{ reset(): void; dispose(): void } | undefined> {
	const api = await loadTurnstile();
	if (signal.aborted) return;
	const id = api.render(element, {
		sitekey,
		theme: "auto",
		callback: (token: string) => {
			if (!signal.aborted) onToken(token);
		},
		"expired-callback": () => {
			if (!signal.aborted) onToken("");
		},
		"error-callback": () => {
			if (!signal.aborted) onToken("");
		},
	});
	const dispose = () => api.remove(id);
	signal.addEventListener("abort", dispose, { once: true });
	return {
		reset() {
			onToken("");
			api.reset(id);
		},
		dispose,
	};
}

export function secureUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	try {
		const url = new URL(value);
		if (url.protocol === "https:") return url.href;
	} catch {
		/* Ignore invalid public links. */
	}
}
