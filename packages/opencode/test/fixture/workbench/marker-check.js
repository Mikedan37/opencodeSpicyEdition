// Deterministic stand-in checker for gate tests: every *.chk file in the folder that contains BROKEN is an
// error, printed as `file:line:col: error: message` like a compiler would.
const fs = require("fs")
const path = require("path")

const dir = process.argv[2]
const broken = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".chk") && fs.readFileSync(path.join(dir, name), "utf8").includes("BROKEN"))
for (const name of broken) console.log(`${name}:1:1: error: broken marker`)
process.exit(broken.length ? 1 : 0)
