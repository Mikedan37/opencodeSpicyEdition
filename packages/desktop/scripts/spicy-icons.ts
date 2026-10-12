// spicy: regenerates every channel's icons from the Icon Composer source `icons/AppIcon.icon`.
// The packaged macOS app uses AppIcon.icon directly (electron-builder compiles it with actool into
// Assets.car, so macOS 26+ renders real Liquid Glass). This script bakes the same design into the
// formats other surfaces need: icon.icns (older macOS), icon.ico (Windows), PNGs (Linux, window
// icons) and dock.png (unpackaged dev Dock icon). Needs Xcode 26+ (Icon Composer's ictool) and iconutil.
import { $ } from "bun"
import path from "path"

const ictool = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
const iconsDir = path.resolve(import.meta.dir, "../icons")
const source = path.join(iconsDir, "AppIcon.icon")
const work = (await $`mktemp -d`.text()).trim()

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
await Promise.all(
  sizes.map(
    (px) =>
      $`${ictool} ${source} --export-image --output-file ${path.join(work, `${px}.png`)} --platform macOS --rendition Default --width ${px} --height ${px} --scale 1 --design-generation 27`.quiet(),
  ),
)
const png = (px: number) => path.join(work, `${px}.png`)

const iconset = path.join(work, "icon.iconset")
await $`mkdir -p ${iconset}`
const iconsetEntries = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
] as const
await Promise.all(iconsetEntries.map(([name, px]) => $`cp ${png(px)} ${path.join(iconset, name)}`))
await $`iconutil -c icns ${iconset} -o ${path.join(work, "icon.icns")}`

// ICO with PNG-compressed entries (Vista+), largest last like most Windows tooling.
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(icoSizes.map((px) => Bun.file(png(px)).bytes()))
const header = Buffer.alloc(6 + 16 * images.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
images.reduce((offset, data, i) => {
  const entry = 6 + 16 * i
  const px = icoSizes[i]
  header.writeUInt8(px >= 256 ? 0 : px, entry)
  header.writeUInt8(px >= 256 ? 0 : px, entry + 1)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(data.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  return offset + data.length
}, header.length)
await Bun.write(path.join(work, "icon.ico"), Buffer.concat([header, ...images]))

const outputs = [
  ["icon.icns", path.join(work, "icon.icns")],
  ["icon.ico", path.join(work, "icon.ico")],
  ["icon.png", png(512)],
  ["dock.png", png(256)],
  ["32x32.png", png(32)],
  ["64x64.png", png(64)],
  ["128x128.png", png(128)],
  ["128x128@2x.png", png(256)],
] as const

for (const channel of ["dev", "beta", "prod"]) {
  const dir = path.join(iconsDir, channel)
  await $`rm -rf ${path.join(dir, "AppIcon.icon")}`
  await $`cp -R ${source} ${path.join(dir, "AppIcon.icon")}`
  await Promise.all(outputs.map(([name, from]) => $`cp ${from} ${path.join(dir, name)}`))
  console.log(`Wrote ${channel} icons`)
}

await $`rm -rf ${work}`
