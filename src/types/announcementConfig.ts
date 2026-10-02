export type AnnouncementConfig = {
	// enable属性已移除，现在通过sidebarLayoutConfig统一控制
	title?: string; // 公告栏标题
	content: string; // 公告栏内容
	/**
	 * 是否启用「动态公告」接口 /api/public/announcements。
	 * 该接口当前未部署（无对应云函数/路由），开启会每页请求一次并产生 404 控制台报错，
	 * 触发 Lighthouse Best Practices「Browser errors」扣分。默认关闭，仅用静态 content。
	 */
	enableApi?: boolean; // 是否启用动态公告 API
	icon?: string; // 公告栏图标
	type?: "info" | "warning" | "success" | "error"; // 公告类型
	closable?: boolean; // 是否可关闭
	link?: {
		enable: boolean; // 是否启用链接
		text: string; // 链接文字
		url: string; // 链接地址
		external?: boolean; // 是否外部链接
	};
};
