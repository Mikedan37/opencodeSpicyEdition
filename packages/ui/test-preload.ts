// Bun compiles JSX against the tsconfig's jsxImportSource, `solid-js`, whose jsx-runtime entry is types only (no
// `jsx`/`jsxDEV`). Bun 1.4 refuses to link a module that imports a missing export, so tests importing any .tsx module
// failed. Tests point bun's JSX at solid's hyperscript runtime instead; builds compile JSX with babel-preset-solid.
Bun.plugin({
  name: "solid-h-jsx",
  setup(build) {
    // Same line, so line numbers in stack traces stay right.
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => ({
      contents: `/** @jsxImportSource solid-js/h */ ${await Bun.file(args.path).text()}`,
      loader: args.path.endsWith(".tsx") ? "tsx" : "jsx",
    }))
  },
})
