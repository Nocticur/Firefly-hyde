import {
	mountChallenge,
	type PublicConfig,
	publicRequest,
	secureUrl,
} from "./public-interactions";

type PublicFriend = {
	id: string;
	name: string;
	url: string;
	avatar: string;
	description: string;
	group: string;
	order: number;
};

function child(tag: string, className: string, text?: string): HTMLElement {
	const element = document.createElement(tag);
	element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

export function registerPublicFriends(): void {
	if (customElements.get("public-friends")) return;
	class PublicFriends extends HTMLElement {
		private controller?: AbortController;
		private challenge?: { reset(): void; dispose(): void };
		private token = "";
		private busy = false;

		connectedCallback() {
			this.controller = new AbortController();
			this.busy = false;
			const signal = this.controller.signal;
			const form = document.querySelector<HTMLFormElement>("#friend-link-form");
			form?.addEventListener("submit", this.submit, { signal });
			void this.initialize(signal);
		}

		disconnectedCallback() {
			this.controller?.abort();
			this.challenge = undefined;
			this.token = "";
		}

		private status(message: string) {
			const status = document.querySelector<HTMLElement>(
				"[data-friend-status]",
			);
			if (status) status.textContent = message;
		}

		private refreshButton() {
			const button =
				document.querySelector<HTMLButtonElement>("#friend-submit-btn");
			if (button) button.disabled = this.busy || !this.token;
		}

		private async initialize(signal: AbortSignal) {
			this.refreshButton();
			const loading = document.getElementById("friends-loading");
			loading?.classList.remove("hidden");
			try {
				const [config, result] = await Promise.all([
					publicRequest<PublicConfig>("/api/public/config", { signal }),
					publicRequest<{ items: PublicFriend[] }>("/api/public/friends", {
						signal,
					}),
				]);
				if (signal.aborted) return;
				this.render(result.items);
				if (!config.friendsEnabled || !config.turnstileSiteKey) {
					this.status("友链申请暂未开放，欢迎稍后再来。");
					return;
				}
				const host = document.querySelector<HTMLElement>(
					"[data-friend-challenge]",
				);
				if (!host) return;
				this.challenge = await mountChallenge(
					host,
					config.turnstileSiteKey,
					(token) => {
						this.token = token;
						this.refreshButton();
					},
					signal,
				);
				this.status("申请审核后，站点上线时会通过邮件通知。");
			} catch {
				if (!signal.aborted) this.status("友链服务暂不可用，请稍后再试。");
			} finally {
				if (!signal.aborted) loading?.classList.add("hidden");
			}
		}

		private render(items: PublicFriend[]) {
			const grid = document.getElementById("friends-grid");
			if (!grid) return;
			const friends = items
				.filter((item) => secureUrl(item.url))
				.sort(
					(a, b) =>
						(a.group || "").localeCompare(b.group || "", "zh-CN") ||
						a.order - b.order ||
						a.id.localeCompare(b.id),
				);
			grid.replaceChildren();
			if (!friends.length)
				grid.append(
					child(
						"p",
						"col-span-full text-center py-12 text-(--content-meta)",
						"暂无友链，欢迎申请互换。",
					),
				);
			for (const item of friends) {
				const link = document.createElement("a");
				link.href = secureUrl(item.url) || "";
				link.target = "_blank";
				link.rel = "noopener noreferrer";
				link.dataset.tags = item.group || "";
				link.dataset.group = item.group || "";
				link.className =
					"friend-card friend-list-card group flex items-center gap-3 p-2.5 rounded-xl border border-(--line-divider) hover:border-(--primary) hover:bg-(--card-bg) transition-all duration-300 hover:shadow-lg relative overflow-hidden animate-fade-in-up";
				link.append(
					child(
						"div",
						"absolute inset-0 bg-(--primary) opacity-0 group-hover:opacity-5 transition-opacity duration-300 pointer-events-none",
					),
				);
				const avatar = child(
					"div",
					"friend-card-avatar relative z-10 w-16 h-16 shrink-0 rounded-xl overflow-hidden bg-zinc-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5 group-hover:scale-105 transition-transform duration-300",
				);
				const imageUrl = secureUrl(item.avatar);
				if (imageUrl) {
					const image = document.createElement("img");
					image.src = imageUrl;
					image.alt = item.name;
					image.loading = "lazy";
					image.className = "w-full h-full object-cover";
					avatar.append(image);
				}
				const content = child(
					"div",
					"friend-card-content relative z-10 grow min-w-0 flex flex-col justify-center gap-0.5",
				);
				content.append(
					child(
						"div",
						"font-bold text-base text-(--btn-content) group-hover:text-(--primary) transition-colors truncate pr-4",
						item.name,
					),
				);
				const description = child(
					"div",
					"friend-card-description text-sm text-neutral-500 dark:text-neutral-400 line-clamp-1",
					item.description,
				);
				description.title = item.description;
				content.append(description);
				if (item.group)
					content.append(
						child("span", "text-xs text-(--content-meta)", item.group),
					);
				link.append(avatar, content);
				grid.append(link);
			}
			const count = document.querySelector<HTMLElement>(".friends-count");
			if (count) {
				count.setAttribute("aria-label", `当前共收录 ${friends.length} 个友链`);
				const number = count.querySelector("strong");
				if (number) number.textContent = String(friends.length);
			}
			const filter = document.querySelector("friend-filter");
			const all = filter?.querySelector<HTMLButtonElement>(
				'button[data-tag="all"]',
			);
			if (all?.parentElement) {
				for (const button of all.parentElement.querySelectorAll(
					'[data-tag]:not([data-tag="all"])',
				))
					button.remove();
				for (const group of [
					...new Set(friends.map((item) => item.group).filter(Boolean)),
				]) {
					const button = document.createElement("button");
					button.type = "button";
					button.dataset.tag = group;
					button.className =
						"btn-regular category-pill px-3 py-1.5 rounded-lg text-sm font-medium transition-colors";
					button.textContent = group;
					all.parentElement.append(button);
				}
			}
			if (friends.length) {
				(
					filter as (HTMLElement & { applyFilters?: () => void }) | null
				)?.applyFilters?.();
			} else {
				grid
					.closest(".card-base")
					?.querySelector(".friends-empty")
					?.classList.add("hidden");
			}
		}

		private submit = async (event: Event) => {
			event.preventDefault();
			const form = document.querySelector<HTMLFormElement>("#friend-link-form");
			if (!form || this.busy || !this.token || !form.reportValidity()) return;
			const fields = new FormData(form);
			const signal = this.controller?.signal;
			this.busy = true;
			this.refreshButton();
			try {
				await publicRequest("/api/public/friends", {
					method: "POST",
					signal,
					body: JSON.stringify({
						name: fields.get("title"),
						url: fields.get("siteUrl"),
						avatar: fields.get("imgUrl"),
						description: fields.get("desc"),
						email: fields.get("email"),
						message: fields.get("message") || "",
						turnstileToken: this.token,
					}),
				});
				if (signal?.aborted || !this.isConnected) return;
				const steps = document.getElementById("friend-apply-steps");
				const success = document.getElementById("friend-form-success");
				if (steps && success) {
					steps.style.display = "none";
					success.classList.remove("hidden");
					success.style.display = "flex";
				} else {
					form.reset();
					this.status("申请已提交，审核结果会通过邮件通知。");
				}
			} catch (error) {
				if (!signal?.aborted && this.isConnected)
					this.status(
						error instanceof Error ? error.message : "提交失败，请稍后再试。",
					);
			} finally {
				if (!signal?.aborted) {
					this.busy = false;
					if (this.isConnected) this.challenge?.reset();
					this.refreshButton();
				}
			}
		};
	}
	customElements.define("public-friends", PublicFriends);
}
