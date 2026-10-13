import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
  // spicy: packages Vite would only find when a page first renders Markdown (the renderer's worker and lazy parser);
  // finding them mid-run makes the dev server re-optimize and reload every open page, which broke cold e2e runs
  optimizeDeps: {
    include: [
      "marked",
      "marked-shiki",
      "@opencode-ai/ui > katex",
      "@opencode-ai/session-ui > remend",
      "@opencode-ai/session-ui > @shikijs/stream",
    ],
  },
})
