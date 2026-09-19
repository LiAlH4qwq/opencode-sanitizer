import { defineConfig } from "rolldown"

export default defineConfig({
  input: "src/sanitizer.ts",
  platform: "node",
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "sanitizer.js",
  },
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
})
