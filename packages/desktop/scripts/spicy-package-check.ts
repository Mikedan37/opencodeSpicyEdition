#!/usr/bin/env bun
// spicy: build the macOS desktop app from source as an unsigned, un-notarized --dir bundle and check its icon wiring
// (Assets.car from the Icon Composer source, Info.plist icon keys, a clean actool compile). Offline: the models
// snapshot comes from the test fixture and the dev CLI download in scripts/prebuild.ts is skipped, which is why the
// prebuild steps are run one by one here instead of through `bun run build` (its prebuild hook fetches both).
//
//   bun scripts/spicy-package-check.ts [--skip-build]
import { mkdtemp, cp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

const desktop = path.resolve(import.meta.dir, "..")
const opencode = path.resolve(desktop, "../opencode")
const bundle = path.join(desktop, "dist", "mac-arm64", "OpenCode Dev.app")
const timings: Record<string, string> = {}

async function timed(name: string, run: () => Promise<unknown>) {
  const started = Date.now()
  await run()
  timings[name] = `${((Date.now() - started) / 1000).toFixed(1)} s`
  console.log(`${name}: ${timings[name]}`)
}

if (!process.argv.includes("--skip-build")) {
  await timed("icons + metainfo (dev channel)", async () => {
    await $`bun ./scripts/copy-icons.ts dev`.cwd(desktop)
    await $`bun ./scripts/copy-metainfo.ts dev`.cwd(desktop)
  })
  await timed("opencode node server bundle", () =>
    $`bun script/build-node.ts`
      .cwd(opencode)
      .env({ ...process.env, MODELS_DEV_API_JSON: path.join(opencode, "test/tool/fixtures/models-api.json") }),
  )
  await timed("electron-vite build", () =>
    $`node_modules/.bin/electron-vite build`.cwd(desktop).env({ ...process.env, OPENCODE_CHANNEL: "dev" }),
  )
  await timed("electron-builder --mac dir (unsigned, no notarization)", async () => {
    await rm(path.join(desktop, "dist"), { recursive: true, force: true })
    await $`node_modules/.bin/electron-builder --mac dir --arm64 --config electron-builder.config.ts -c.mac.identity=null -c.mac.notarize=false -c.npmRebuild=false`
      .cwd(desktop)
      .env({ ...process.env, OPENCODE_CHANNEL: "dev", CSC_IDENTITY_AUTO_DISCOVERY: "false" })
  })
}

const resources = path.join(bundle, "Contents", "Resources")
const plist = path.join(bundle, "Contents", "Info.plist")
const read = (key: string) =>
  $`plutil -extract ${key} raw ${plist}`
    .nothrow()
    .text()
    .then((text) => text.trim())
const car = await stat(path.join(resources, "Assets.car")).catch(() => undefined)
const icns = await stat(path.join(resources, "icon.icns")).catch(() => undefined)
const iconName = await read("CFBundleIconName")
const iconFile = await read("CFBundleIconFile")
// Unsigned build: only the Electron binary's own ad-hoc linker signature, no Developer ID or Team.
const signature = (await $`codesign -dv ${bundle}`.nothrow().quiet()).stderr
  .toString()
  .split("\n")
  .filter((line) => /^(Signature|TeamIdentifier|Info\.plist)=/.test(line))
  .join(", ")

// Same actool invocation electron-builder makes (app-builder-lib util/macosIconComposer), on a copy of the source,
// to show its notices and warnings, which the builder only prints in debug mode.
const work = await mkdtemp(path.join(tmpdir(), "spicy-actool-"))
await cp(path.join(desktop, "resources", "icons", "AppIcon.icon"), path.join(work, "Icon.icon"), { recursive: true })
await $`mkdir -p ${path.join(work, "out")}`
const actool =
  await $`xcrun actool ${path.join(work, "Icon.icon")} --compile ${path.join(work, "out")} --output-format human-readable-text --notices --warnings --output-partial-info-plist ${path.join(work, "out", "assetcatalog_generated_info.plist")} --app-icon Icon --include-all-app-icons --accent-color AccentColor --enable-on-demand-resources NO --development-region en --target-device mac --minimum-deployment-target 26.0 --platform macosx`
    .nothrow()
    .quiet()
const actoolOutput = `${actool.stdout}${actool.stderr}`.trim()
const actoolCar = await stat(path.join(work, "out", "Assets.car")).catch(() => undefined)
const actoolVersion = (await $`xcrun actool --version`.nothrow().text()).match(
  /short-bundle-version<\/key>\s*<string>([^<]+)</,
)?.[1]
await rm(work, { recursive: true, force: true })

const checks = {
  "Assets.car in Resources": !!car,
  "icon.icns in Resources": !!icns,
  "CFBundleIconName = Icon": iconName === "Icon",
  "CFBundleIconFile = icon.icns": iconFile === "icon.icns",
  "actool exit 0": actool.exitCode === 0,
  "actool reported no errors": !/error/i.test(actoolOutput),
  "actool output matches the bundled Assets.car": !!actoolCar && !!car && actoolCar.size === car.size,
}
console.log(
  JSON.stringify(
    {
      bundle,
      timings,
      assetsCarBytes: car?.size,
      icnsBytes: icns?.size,
      CFBundleIconName: iconName,
      CFBundleIconFile: iconFile,
      signature,
      actoolVersion,
      actoolOutput,
      checks,
    },
    null,
    2,
  ),
)
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
