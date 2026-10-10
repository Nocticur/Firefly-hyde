import type { AnnouncementConfig } from "../types/announcementConfig";

export const announcementConfig: AnnouncementConfig = {
	// 公告标题
	title: "",

	// 公告内容
	content: "👋🏻 Hi，我是Nocticur，欢迎您！",

	// 是否启用动态公告接口 /api/public/announcements（当前无对应后端，开启会 404 报错，默认关闭仅用静态 content）
	enableApi: false,

	// 是否允许用户关闭公告
	closable: false,

	link: {
		// 启用链接
		enable: true,
		// 链接文本
		text: "了解更多",
		// 链接 URL
		url: "/about/",
		// 内部链接
		external: false,
	},
};
