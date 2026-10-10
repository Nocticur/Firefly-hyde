// 旧说说代码和资料保留在仓库，未导入为 Nocticur 的历史数据。
// 仅在单独审核并发布新站内容后启用对应来源；配置不得包含任何认证凭据。
interface ExternalMomentsConfig {
	enable: boolean;
	localContentEnabled: boolean;
	gistId: string;
	fileName: string;
	defaultAuthor: string;
	defaultAvatar: string;
}

export const externalMomentsConfig: ExternalMomentsConfig = {
	enable: false,
	localContentEnabled: false,
	gistId: "",
	fileName: "moments.json",
	defaultAuthor: "Nocticur",
	defaultAvatar: "/assets/images/logo-nocticur.png",
};
