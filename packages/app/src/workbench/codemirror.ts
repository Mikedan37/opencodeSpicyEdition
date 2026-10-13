// The IDE's CodeMirror look and languages, shared by the editor (editor-view.tsx) and the code views of other tabs
// (code-view.tsx). Imported only from lazily loaded modules, so CodeMirror stays out of the first chunk.
import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { HighlightStyle } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { languageOf, type GlyphKind, type LanguageKey } from "./editor"

// Language support loads with the first file of its kind.
export const LANGUAGES: Record<LanguageKey, () => Promise<Extension>> = {
  ts: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ typescript: true, jsx: true })),
  js: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ jsx: true })),
  python: () => import("@codemirror/lang-python").then((mod) => mod.python()),
  rust: () => import("@codemirror/lang-rust").then((mod) => mod.rust()),
  cpp: () => import("@codemirror/lang-cpp").then((mod) => mod.cpp()),
  go: () => import("@codemirror/lang-go").then((mod) => mod.go()),
  json: () => import("@codemirror/lang-json").then((mod) => mod.json()),
  markdown: () => import("@codemirror/lang-markdown").then((mod) => mod.markdown()),
  swift: () =>
    Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/swift")]).then(
      ([language, mode]) => language.StreamLanguage.define(mode.swift),
    ),
}

// The app's syntax tokens (ui theme.css), so the editor reads like the viewer in light and dark.
export const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: "var(--syntax-comment)" },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
      tags.modifier,
      tags.self,
    ],
    color: "var(--syntax-keyword)",
  },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syntax-primitive)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--syntax-property)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    color: "var(--syntax-primitive)",
  },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "var(--syntax-constant)" },
  { tag: tags.regexp, color: "var(--syntax-regexp)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: "var(--syntax-punctuation)" },
  { tag: tags.heading, color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--syntax-primitive)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--syntax-critical)" },
])

const PAUSED = "rgb(from var(--v2-state-fg-warning) r g b / 0.18)"
const SELECTED = "rgb(from var(--v2-border-border-focus) r g b / 0.12)"
const GLYPH_COLOR: Record<GlyphKind, string> = {
  line: "var(--v2-state-fg-danger)",
  condition: "var(--v2-state-fg-warning)",
  log: "var(--v2-state-fg-warning)",
  unverified: "var(--v2-state-fg-danger)",
  error: "var(--v2-state-fg-danger)",
  warning: "var(--v2-state-fg-warning)",
  info: "var(--v2-state-fg-info)",
  hint: "var(--v2-text-text-faint)",
}

// Font, size and line height of the read-only viewer (session-ui pierre styleVariables).
export const THEME = EditorView.theme({
  "&": { color: "var(--v2-text-text-base)", backgroundColor: "transparent", fontSize: "var(--font-size-small)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-family-mono)",
    fontFeatureSettings: "var(--font-family-mono--font-feature-settings)",
    lineHeight: "24px",
  },
  ".cm-content": { caretColor: "var(--v2-text-text-base)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--v2-text-text-base)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgb(from var(--v2-border-border-focus) r g b / 0.28)",
  },
  ".cm-activeLine": { backgroundColor: "rgb(from var(--v2-text-text-base) r g b / 0.04)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--v2-text-text-faint)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--v2-text-text-muted)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 2px", minWidth: "3ch", cursor: "pointer" },
  ".cm-spicy-glyphs .cm-gutterElement": { width: "16px", cursor: "pointer", display: "flex", alignItems: "center" },
  ".cm-spicy-glyph": { display: "inline-block", margin: "0 auto" },
  ...Object.fromEntries(
    (["line", "condition", "log"] as const).map((kind) => [
      `.cm-spicy-glyph-${kind}`,
      { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: GLYPH_COLOR[kind] },
    ]),
  ),
  ".cm-spicy-glyph-unverified": {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    boxShadow: `inset 0 0 0 1.5px ${GLYPH_COLOR.unverified}`,
  },
  ...Object.fromEntries(
    (["error", "warning", "info", "hint"] as const).map((kind) => [
      `.cm-spicy-glyph-${kind}`,
      { width: "3px", height: "12px", borderRadius: "1px", backgroundColor: GLYPH_COLOR[kind] },
    ]),
  ),
  ".cm-spicy-exec": { backgroundColor: PAUSED },
  ".cm-gutterElement.cm-spicy-exec-gutter": {
    backgroundColor: PAUSED,
    color: "var(--v2-state-fg-warning)",
  },
  ".cm-lineNumbers .cm-gutterElement.cm-spicy-exec-gutter": { boxShadow: "inset 3px 0 0 var(--v2-state-fg-warning)" },
  ".cm-spicy-selected": { backgroundColor: SELECTED },
  ".cm-spicy-commented": { boxShadow: "inset 2px 0 0 var(--v2-border-border-focus)" },
  ".cm-spicy-values": {
    padding: "0 12px",
    fontSize: "11px",
    lineHeight: "20px",
    color: "var(--v2-state-fg-warning)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "rgb(from var(--v2-border-border-focus) r g b / 0.2)",
    outline: "1px solid rgb(from var(--v2-border-border-focus) r g b / 0.5)",
  },
  ".cm-panels": {
    backgroundColor: "var(--v2-background-bg-base)",
    color: "var(--v2-text-text-base)",
    fontFamily: "var(--font-family-sans)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--v2-border-border-muted)" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px" },
  ".cm-panel.cm-search label": { fontSize: "12px", color: "var(--v2-text-text-muted)" },
  ".cm-textfield": {
    fontSize: "12px",
    padding: "2px 6px",
    border: "1px solid var(--v2-border-border-muted)",
    borderRadius: "4px",
    backgroundColor: "var(--v2-background-bg-base)",
    color: "var(--v2-text-text-base)",
  },
  ".cm-textfield:focus": { outline: "none", borderColor: "var(--v2-border-border-focus)" },
  ".cm-button": {
    fontSize: "12px",
    padding: "2px 8px",
    backgroundImage: "none",
    backgroundColor: "var(--v2-background-bg-layer-01)",
    border: "1px solid var(--v2-border-border-muted)",
    borderRadius: "4px",
    color: "var(--v2-text-text-base)",
  },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--v2-background-bg-layer-02)" },
  ".cm-searchMatch": { backgroundColor: "rgb(from var(--v2-state-fg-warning) r g b / 0.22)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(from var(--v2-state-fg-warning) r g b / 0.45)" },
  ".cm-tooltip": {
    backgroundColor: "var(--v2-background-bg-base)",
    color: "var(--v2-text-text-base)",
    border: "1px solid var(--v2-border-border-muted)",
    borderRadius: "6px",
    fontFamily: "var(--font-family-sans)",
    fontSize: "12px",
  },
  ".cm-spicy-comment": {
    display: "block",
    padding: "2px 8px",
    font: "inherit",
    color: "var(--v2-text-text-base)",
    cursor: "pointer",
  },
})

// The language of a file by its extension, once its support has loaded; undefined for plain text.
export function loadLanguage(path: string) {
  const key = languageOf(path)
  return key ? LANGUAGES[key]().catch(() => undefined) : Promise.resolve(undefined)
}
