// A formatter for the editor's fallback: rewrites the file named on the command line in upper case.
const { readFileSync, writeFileSync } = require("fs")
writeFileSync(process.argv[2], readFileSync(process.argv[2], "utf8").toUpperCase())
