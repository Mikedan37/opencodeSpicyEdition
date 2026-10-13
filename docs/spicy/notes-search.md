# Project search and replace notes (`spicy-review`, wave 1)

A **Search** tab in the side panel (new layout, next to Files Changed and Debug): search the project's files,
see each matching line by file, open a match in the editor at its line, and replace one match, a file's
matches or all of them. Replaces never overwrite a file that changed since it was searched and never touch a
file with unsaved edits in the editor.

## Using it

- **Open**: `mod+shift+F` from anywhere in a session (the composer, the editor, the terminal: it is a fork key
  that fires while typing, `workbench/keys.ts`), the command palette's "Search in files" (category Search), or
  the Search tab. It opens the side panel when it is closed, focuses the query and selects it. The tab shows
  over the panel's selected tab like the Debug tab; opening another tab or a file hides it, and the query,
  results and report stay until the tab comes back.
- **Query**: literal text by default; toggles for Match case (`Aa`, default ignore case), Match whole word
  (`ab`) and regular expressions (`.*`); "Files to include" / "Files to exclude" take comma-separated globs or
  paths (`src`, `*.ts`, `docs/**`, `*.{js,ts}`): a plain path also covers everything under it, at any depth when
  it has no slash, like VS Code. Typing searches after 250 ms; Enter searches at once; "Search again" refreshes.
  Search is gitignore-aware, includes hidden files and skips `.git`.
- **Results**: "N matches in M files", files in path order with their match counts (collapsible), one row per
  match with its line number and the line, the match highlighted (leading indentation trimmed; long lines start
  shortly before the match). Clicking a row opens the file in the editor with that line selected and scrolled
  into view. Past 2,000 matches the rest are counted, not listed: "N more matches not shown. Narrow the search to
  see them." An invalid pattern or glob shows ripgrep's (or JavaScript's) message.
- **Replace**: the chevron opens the replace field; every row then previews old → new (struck out red, green).
  Regular-expression replaces fill in `$1`, `$&`, `$<name>` with JavaScript's rules; literal ones are literal.
  Each row has Replace, each file row Replace in file (on hover or focus); Replace all asks first: "Replace
  N matches in M files?" (files that will be skipped are not counted). Afterwards a report says what was
  replaced and lists every skipped file with its reason: **changed since search** (the server refused the
  write, 409, or the file no longer has the match where it was listed, or was deleted), **unsaved edits in the
  editor** (a buffer with unsaved changes is never written under; the file row shows an Unsaved tag
  beforehand), **not a text file the editor can write** (binary, not UTF-8, over 8 MB; Read-only tag), or the
  request's error. Replaced matches disappear from the results (the listed lines show the file as written;
  if the replacement still matches, that match stays listed).

## How it works

- `GET /workbench/search?query=&regex=&case=&word=&include=&exclude=` (`groups/workbench-search.ts`,
  `src/workbench/search.ts`): ripgrep `--json` in the instance directory (`--hidden`, `--glob=!**/.git/**`,
  `--fixed-strings` unless regex, `--ignore-case` unless case, `--word-regexp`, `--engine=auto` for regexes so
  look-around and backreferences work through PCRE2). Lines are sent until they hold 2,000 matches (`listed`);
  past that a second `--count-matches` pass gives `total`. Each line is cut at 2,000 characters. Every listed
  file comes with the sha256 of its bytes read right after the search (`WorkbenchEditorFile.read`, the same
  hash `GET/PUT /workbench/file` use), or no hash when the editor cannot open it. A refused pattern or glob is a
  400 with ripgrep's message. Workbench bridge tokens do not reach the route (403, `security-bridge-token`
  test). rg leaves a UTF-8 BOM out of line 1; lines that are not UTF-8 are skipped.
- **Matching inside lines and replacing are the client's** (`packages/app/src/workbench/search.ts`): the
  query compiles to one JavaScript RegExp (Unicode-aware; whole word = no letter, mark, digit or connector
  right before or after, as ripgrep's `-w`; a regex that only compiles without the `u` flag, such as `\-`, gets
  ASCII semantics). The same function finds the highlighted ranges, computes the preview and builds the write,
  so what is shown is what is written. A line ripgrep matched that JavaScript does not is not listed.
- **A replace** reads the file (`GET /workbench/file`), replaces exactly the listed matches in that text
  (each must still be there, matched by the same pattern, else the file is skipped as changed), and writes it
  with `PUT /workbench/file` and the **hash from the search** as `baseHash`: the server writes only if the
  bytes on disk still hash to it, so any change since the search ends in a 409 and the file is skipped, never
  overwritten. The editor buffer of a file without unsaved edits follows the new text (the write publishes the
  watcher event); a file with unsaved edits is not touched (checked right before its write). Files are written
  one after another; a newer search arriving meanwhile is never mixed into the old results.

## Files

Fork-owned (new): `packages/opencode/src/workbench/search.ts`,
`packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/workbench-search.ts`,
`packages/opencode/test/workbench/search.test.ts`, `packages/opencode/test/server/httpapi-exercise/search.ts`,
`packages/app/src/workbench/{search.ts,search.test.ts,search-side.tsx,search-side.css,search-panel.tsx}`,
`packages/app/e2e/regression/search-replace.spec.ts`. Add-only lines in fork files:
`packages/app/src/workbench/client.ts` (`search`, `SearchResult`), `packages/app/src/workbench/en.ts`
(`workbench.search.*`), `packages/app/src/workbench/keys.ts` (`SEARCH_KEYS`, editable while typing),
`packages/opencode/test/workbench/security-bridge-token.test.ts` (search is denied to tokens).

Upstream-owned files touched (each edit marked `spicy:`; please add to `SPICY.md`):

| File                                                             | Change                                                                                                                                                    | Why                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/app/src/pages/session/session-side-panel.tsx`          | import; `useSearchSideTab`; Tabs `value` / `onChange` / `data-workbench-search`; `<SearchSideTrigger />` after the Debug trigger; `<SearchSideContent />` | the Search tab                                  |
| `packages/app/src/pages/session.tsx`                             | import; `<SearchProvider>` inside the existing `<ReviewProvider>` seam                                                                                    | state + `mod+shift+F` while the panel is closed |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | import; `.addHttpApi(WorkbenchSearchApi)`                                                                                                                 | the route                                       |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | imports; `workbenchSearchHandlers`; `WorkbenchSearch.node`                                                                                                | handler and service                             |
| `packages/opencode/test/server/httpapi-exercise/index.ts`        | import; `...searchScenarios`                                                                                                                              | `test:httpapi` coverage                         |

## Tests

| Test                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test test/workbench/search.test.ts` (opencode, real rg through the HTTP API)                                                                                                                     | 6 pass: path order, gitignore, hidden files, hash = sha256 of the bytes, BOM line, counts; case, whole word, regex, look-behind via PCRE2, literal `foo(`; include/exclude globs and plain paths; 400 for a bad regex, a bad glob, an empty query; the 2,000-match cap with the rest counted; no hash for a file over 8 MB |
| `bun test --conditions=solid --preload ./happydom.ts src/workbench/search.test.ts` (app)                                                                                                              | 11 pass: literal/case/whole word (any script)/regex compile, fallback without `u`, empty matches; replacement preview (literal stays literal, groups, look-behind); planning (only listed matches, CRLF and BOM kept, regex groups per match, changed file → nothing); results to rows, collapse, relisting after a write  |
| `e2e/regression/search-replace.spec.ts` (real server)                                                                                                                                                 | pass, 3/3 with `--repeat-each=3`; see below                                                                                                                                                                                                                                                                                |
| existing e2e: debug-panel, editor-save, review-agent-changes, review-open-file, review-tab-switch, review-state-persistence, file-browser-sidebar-tab-switch, open-file-expand-folder, problems-panel | 30 pass (31 with the search spec)                                                                                                                                                                                                                                                                                          |
| opencode `bun test` (all)                                                                                                                                                                             | 3893 pass / 28 skip / 1 todo / 0 fail                                                                                                                                                                                                                                                                                      |
| opencode `bun run test:httpapi`                                                                                                                                                                       | 271 / 271 in coverage, auth and effect modes (`workbench.search` included)                                                                                                                                                                                                                                                 |
| app `bun test` (all of `src`, 116 files)                                                                                                                                                              | 825 pass / 0 fail                                                                                                                                                                                                                                                                                                          |
| `bun run typecheck` (opencode, app)                                                                                                                                                                   | clean                                                                                                                                                                                                                                                                                                                      |

Route timing on this monorepo (warm server, load average ~17): a narrow query (7 files) 85–260 ms, `createMemo`
(1,891 matches in 253 files, all hashed, 198 KB) 220–350 ms, `const` (capped, 68,094 counted) 170–210 ms, `e`
(capped, 3.5 million counted) 95–150 ms.

The e2e starts `opencode serve` from this checkout (isolated XDG dirs) on `PLAYWRIGHT_SERVER_PORT`, with four
files in a git project, and checks: `Ctrl+Shift+F` from the composer opens the closed side panel on the Search
tab with the query focused; "alpha" → "9 matches in 4 files", files in path order with counts, `Alpha`
matched ignoring case; `alpha\d+` finds nothing until the regex toggle, then `alpha1` and `alpha22`; clicking
the `useAlpha` match opens `src/alpha.ts` in the editor with line 2 selected; typing there leaves unsaved edits;
`Ctrl+Shift+F` from the editor brings the search back as it was; `docs/notes.md` is changed on disk after the
search; with "omega" the previews show; Replace all asks "Replace 6 matches in 3 files?"; the write of
`docs/notes.md` gets a 409; the report says 5 matches in 2 files replaced and lists `src/alpha.ts` (unsaved)
and `docs/notes.md` (changed); the files on disk are exactly as expected and `src/alpha.ts` is untouched with
its edits still in the editor; Search again lists the changed file anew and its single Replace writes it;
another tab hides the search, the Search tab and the palette command bring it back. Run from `packages/app`:

```sh
PLAYWRIGHT_PORT=3361 PLAYWRIGHT_SERVER_PORT=4361 bunx playwright test e2e/regression/search-replace.spec.ts
```

It also writes 2,100 more matching lines and checks "103 more matches not shown" with 2,000 listed.
Screenshots: `packages/app/e2e/test-results/<test>/1-results.png` … `8-capped.png` (gitignored).

Benchmarks (app AGENTS.md rule; production builds; interleaved runs of HEAD's two session seams vs this change;
other agents kept the load average at 13–32):

- `first-navigation` and `session-tab-switch` (3 rounds × 2 repeats, n=6 per arm): unchanged within noise, in
  both directions (v2 closed cold first paint 14.1 → 14.4 ms, v2 open cold stable 31.8 → 28.5 ms, child
  session first destination 38.0 → 39.5 ms and stable 44.0 → 42.8 ms, hot switches 2.4 → 2.4–2.5 ms).
- `review-pane-scaling` (stable ready, from the click that opens the panel): round 1 (n=6) after slower by
  2–12 ms in four of five sizes; round 2 (n=12) mixed: 100 lines 100.2 → 104.5, 1,000 lines 109.5 → 108.1,
  10,000 lines 120.3 → 131.8, 100,000 lines 167.3 → 168.0, 1,000,000 lines 632.5 → 636.6 ms. A third round at
  load average ~30 was dominated by spikes (samples up to 490 ms) and is not used. What the change mounts with
  the panel is one tab trigger, one effect, one hidden `Show` and one CSS rule shaped like the Debug tab's; a
  re-run on a quiet machine would settle whether the small-case shift is real.

## Gaps and limits

- New layout only (like the Debug tab); the old layout and mobile have no Search tab.
- No replace keyboard shortcuts (VS Code's `mod+shift+H`, `mod+alt+enter`), no preserve-case, no search in
  open editors' unsaved text (the search reads the files on disk; a dirty file is listed as on disk), no
  multi-line patterns, no seeding the query from the editor selection.
- Results do not refresh by themselves when files change; a replace on a changed file is refused and reported,
  and Search again lists it anew.
- JavaScript and ripgrep regex dialects differ at the edges (e.g. `\w` is ASCII in JavaScript, Unicode in rg):
  a line rg matched that JavaScript does not match is not listed.
- The hash is read right after ripgrep reads the file: if the file changes in between, the listed line can be
  stale while the hash is new; the replace then works on the new text and replaces a match only where the
  listed text still matches.
- Every search hashes each listed file (bounded by the 2,000-match cap; files over 8 MB are not read).
- ripgrep searches files in parallel, so which lines make the first 2,000 of a capped search can differ from
  one search to the next (files are listed in path order either way).
