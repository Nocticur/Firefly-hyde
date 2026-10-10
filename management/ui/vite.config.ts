import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
	plugins: [react()],
	server: { proxy: { "/api": process.env.MANAGEMENT_API_TARGET ?? "http://127.0.0.1:8787" } },
	build: {
		outDir: "dist", sourcemap: false,
		rollupOptions: { output: { manualChunks: {
			editor: ["@tiptap/react", "@tiptap/starter-kit", "@tiptap/extension-table", "@tiptap/extension-mathematics", "@tiptap/markdown"],
			react: ["react", "react-dom"],
		} } },
	},
});
