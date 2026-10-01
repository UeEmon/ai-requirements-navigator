import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // テストではビルド前のソースを直接参照する
      "@arn/ai-core": fileURLToPath(new URL("../../packages/ai-core/src/index.ts", import.meta.url)),
    },
  },
});
