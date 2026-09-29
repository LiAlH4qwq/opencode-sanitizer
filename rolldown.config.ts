import { defineConfig } from "rolldown"

const external = [
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "@earendil-works/pi-coding-agent",
]

/**
 * Each target is bundled on its own so the opencode plugin and the pi extension
 * are self-contained files. opencode loads a plugin as a single file (dropped
 * into `plugins/` or referenced from config), so a shared chunk would break it.
 */
export default defineConfig([
  {
    input: "src/sanitizer.ts",
    platform: "node",
    output: {
      dir: "dist",
      format: "esm",
      entryFileNames: "sanitizer.js",
    },
    external,
  },
  {
    input: "src/pi.ts",
    platform: "node",
    output: {
      dir: "dist",
      format: "esm",
      entryFileNames: "pi.js",
    },
    external,
  },
])
