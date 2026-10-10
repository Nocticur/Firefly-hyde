import navigation from "../constants/managed-navigation.json";
import values from "../constants/managed-settings.json";
import type { BackgroundWallpaperConfig } from "../types/backgroundWallpaper";
import type { NavBarConfig, NavBarLink } from "../types/navBarConfig";
import type { ProfileConfig } from "../types/profileConfig";
import type { SiteConfig } from "../types/siteConfig";

export type IconSlot =
	| "favicon.svg"
	| "favicon.ico"
	| "favicon-96x96.png"
	| "apple-touch-icon.png"
	| "web-app-manifest-192x192.png"
	| "web-app-manifest-512x512.png";
export interface ManagedSettings {
	title?: string;
	subtitle?: string;
	description?: string;
	author?: string;
	siteUrl?: string;
	timezone?: string;
	siteStartTime?: string;
	avatar?: string;
	homeCover?: string;
	defaultCover?: string;
	background?: string;
	github?: string;
	bilibili?: string;
	qqGroup?: string;
	email?: string;
	signature?: string;
	icons?: Partial<Record<IconSlot, string>>;
}
interface ManagedNavigation {
	id: string;
	name: string;
	url?: string;
	icon?: string;
	external?: boolean;
	order?: number;
	children?: ManagedNavigation[];
}

// These files contain only the explicitly published snapshot. Private drafts live in the management database.
export const managedSettings: ManagedSettings = values;

export function applyManagedSiteConfig(
	config: SiteConfig,
	dateOnly = false,
): void {
	const m = managedSettings;
	if (m.title !== undefined) {
		config.title = m.title;
		config.navbar.title = m.title;
	}
	if (m.subtitle !== undefined) config.subtitle = m.subtitle;
	if (m.description !== undefined) config.description = m.description;
	if (m.siteUrl !== undefined) config.site_url = m.siteUrl;
	if (m.timezone !== undefined) config.timezone = m.timezone;
	if (m.siteStartTime !== undefined)
		config.siteStartDate = dateOnly
			? m.siteStartTime.slice(0, 10)
			: m.siteStartTime;
	if (m.avatar !== undefined)
		config.navbar.logo = {
			type: /^https?:/.test(m.avatar) ? "url" : "image",
			value: m.avatar,
			valueDark: m.avatar,
			alt: m.author ?? config.navbar.logo?.alt,
		};
	const icons = m.icons;
	if (icons) {
		const published = (
			["favicon.svg", "favicon.ico", "favicon-96x96.png"] as const
		)
			.filter((slot) => icons[slot])
			.map((slot) => ({
				src: icons[slot]!,
				...(slot === "favicon-96x96.png" ? { sizes: "96x96" } : {}),
			}));
		if (published.length) config.favicon = published;
	}
}

export function applyManagedProfileConfig(config: ProfileConfig): void {
	const m = managedSettings;
	if (m.author !== undefined) config.name = m.author;
	if (m.avatar !== undefined) config.avatar = m.avatar;
	if (m.signature !== undefined) config.bio = m.signature;
	const contacts = {
		"fa7-brands:github": m.github,
		"fa7-brands:bilibili": m.bilibili,
		"fa7-brands:qq": m.qqGroup,
		"fa7-solid:envelope":
			m.email === undefined ? undefined : `mailto:${m.email}`,
	};
	config.links = config.links.map((link) => {
		const contact = contacts[link.icon as keyof typeof contacts];
		return contact === undefined ? link : { ...link, url: contact };
	});
}

export function applyManagedWallpaper(config: BackgroundWallpaperConfig): void {
	const m = managedSettings;
	if (m.background !== undefined) config.src = m.background;
	const home = config.common?.homeText;
	if (home) {
		if (m.title !== undefined) home.title = m.title;
		if (m.signature !== undefined) home.subtitle = [m.signature];
		const links: ProfileConfig = { name: "", links: home.links ?? [] };
		applyManagedProfileConfig(links);
		home.links = links.links;
	}
}

export function applyManagedNavigation(config: NavBarConfig): void {
	const items: ManagedNavigation[] = navigation;
	if (!items.length) return;
	function convert(entries: ManagedNavigation[]): NavBarLink[] {
		const pageKeys: Record<string, string> = {
			"/friends/": "friends",
			"/guestbook/": "guestbook",
			"/dynamic/": "dynamic",
			"/projects/": "projects",
			"/gallery/": "gallery",
			"/booknav/": "booknav",
			"/bilibili/": "bilibili",
			"/bangumi/": "bangumi",
			"/vndb/": "vndb",
			"/myanimelist/": "mal",
			"/sponsor/": "sponsor",
			"/music/": "music",
			"/places/": "places",
			"/anime/": "anime",
		};
		return [...entries]
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
			.map((item) => ({
				name: item.name,
				url: item.url ?? "#",
				icon: item.icon,
				external: item.external,
				pageKey: item.url ? pageKeys[item.url] : undefined,
				...(item.children ? { children: convert(item.children) } : {}),
			}));
	}
	config.links = convert(items);
}
