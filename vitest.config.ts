import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// One heavy crash-test file at a time; children SIGKILL and reopen shared SQLite files.
		fileParallelism: false,
	},
});
