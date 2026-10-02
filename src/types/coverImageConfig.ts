export type CoverImageConfig = {
	enableInPost: boolean; // 是否在文章详情页显示封面图
	enableInPostOverlay?: boolean; // 是否使用标题和元数据叠加在封面上的布局
	showLoading?: boolean; // 是否显示加载动画
	randomCoverImage: {
		enable: boolean; // 是否启用随机图功能
		/**
		 * 本地封面图池：image: "api" 时优先从这里随机取一张，彻底避免远程请求。
		 * 路径为 public 下的相对地址（以 "/" 开头），例如 "/assets/images/covers/cover-01.webp"。
		 * 按文章 slug 确定性挑选（同一篇文章永远取到同一张），保证首屏不跳变。
		 * 为空或未配置时回退到下方 apis 远程列表。
		 */
		localPool?: string[]; // 本地封面图池（public 路径）
		apis: string[]; // 随机图API列表（本地池为空时的远程兜底/文档保留）
	};
};
