import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfig from "./tsconfig.json";
export default defineConfig({
	plugins: [react()],
	// Shared blog helpers must not require Astro in the independent UI job.
	esbuild: { tsconfigRaw: JSON.stringify(tsconfig) },
	base: process.env.MANAGEMENT_UI_BASE ?? "/",
	server: {
		proxy: {
			"/api": process.env.MANAGEMENT_API_TARGET ?? "http://127.0.0.1:8787",
		},
	},
	build: {
		outDir: "dist",
		sourcemap: false,
		rollupOptions: {
			output: {
				manualChunks: {
					editor: [
						"@tiptap/react",
						"@tiptap/starter-kit",
						"@tiptap/extension-table",
						"@tiptap/extension-mathematics",
						"@tiptap/markdown",
					],
					react: ["react", "react-dom"],
				},
			},
		},
	},
});
