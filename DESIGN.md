---
version: 2
name: SpecFix Review desk
description: >-
  A working desk for reviewing product requirements. A quiet tinted frame holds the navigation;
  the ticket under review sits on one white sheet. The ticket's text and the model's flags are
  side by side, and the one colour on the screen marks the words a flag is about. Colour goes on
  data and status, never on chrome.
supersedes: SpecFix Redline (version 1) — retired 2026-10-25
source: Taste Skill app style "framed-sheet" (seed 618320207, kind support), adapted below

colors:
  frame: "#f9fbfc"       # sidebar + top bar ground (the L-frame)
  sheet: "#ffffff"       # the working sheet and cards
  raised: "#f4f6f8"      # one tone step: wells, selected row, code blocks
  active: "#ebedee"      # nav active pill, selected tab background on phone
  border: "#e8eaec"      # sheet edge, card edges
  rule: "#f0f1f2"        # row rules inside lists
  control: "#cdced1"     # secondary button outline
  field: "#8c8f93"       # input / select / textarea border (3.25:1, WCAG 1.4.11)
  text: "#131416"        # 18.4:1 on sheet
  muted: "#5d5f60"       # 6.4:1 on sheet
  primary: "#1d1f20"     # near-black primary button, white label (16.6:1)
  accent: "#1b6c80"      # teal: quoted spans, the selected flag, focus ring (6.0:1)
  accent-ink: "#134e5c"  # text on accent tints
  mark: "#d9ecf0"        # quoted span highlight in the ticket
  mark-selected: "#b9dde5" # the selected flag's span
  accent-tag: "#e3f0f3"
  positive: "#1e7b4f"    # 5.3:1
  negative: "#c4242a"    # 5.8:1
  warning: "#92400e"     # 7.1:1
  pill-positive: ["#dcfae5", "#04250e"]
  pill-negative: ["#ffedea", "#831c1e"]
  pill-warning:  ["#fffbeb", "#92400e"]   # notice border #fde68a
  pill-neutral:  ["#ebedee", "#353736"]

typography:
  family: "IBM Plex Sans, system-ui, sans-serif"   # the only text face
  mono: "IBM Plex Mono, ui-monospace, monospace"   # ticket keys, IDs, Gherkin, code only
  weights: [400, 500, 600]
  sizes-px: { title: 22, section: 16, reading: 15, body: 14, small: 12 }

rounded: { sheet: 16px, card: 8px, control: 6px, tag: 4px }
spacing: { gap: 24px, pad: 24px, sheet-inset: 8px, sidebar: 228px, topbar: 48px }
controls: { height: 32px, primary-height: 36px, field-height: 38px, row: 48px }
breakpoints-px: { sm: 640, md: 768, lg: 1024, xl: 1280 }
---

# SpecFix — Review desk design system

The single source of design decisions for `apps/web`. `apps/web/app/globals.css` and
`apps/web/tailwind.config.ts` implement these tokens; a token changes here and there in the same
commit. Values come from Taste Skill's measured "framed-sheet" style; every deviation is listed in
§9 with its reason.

## 1. Visual Theme & Atmosphere

SpecFix is worked in, not read once: a reviewer opens a ticket, writes their own gaps blind, then
decides on the model's flags. The screen is a desk for that job.

- **The frame** — one pale tinted L (sidebar + top bar, no rule between them) that holds the
  product, the workspace and the way back to the queue. It never carries colour.
- **The sheet** — the ticket under review on one white sheet, inset 8px from the window's right and
  bottom edges, 16px corners, 1px edge, no shadow. Depth comes from that one tone step.
- **The link** (SpecFix's signature element) — the ticket's text and the flags sit side by side;
  every flag's quoted words are tinted in the ticket, and the selected flag's words are tinted
  darker. Teal appears nowhere else except the focus ring. This is the face of the product: a
  screenshot of any other review tool would not have it.
- **The finding line** — under the title, one plain sentence of where the review stands
  ("Blind list locked · 3 of 6 flags decided · 2 of 4 gaps linked"), next to the one action that
  moves it forward.

Calm, precise, dense enough to work in. No serif, no paper, no decoration.

## 2. Color Palette & Roles

| Token | Role | Never |
|---|---|---|
| `frame` | Sidebar and top bar ground | Behind the working content |
| `sheet` | The sheet, cards, menus, dialogs | — |
| `raised` | Selected flag row, wells (question for the PM), code blocks | A second card level |
| `active` | Active nav item (grey pill) | Coloured nav |
| `border` / `rule` | Sheet and card edges / row rules | Heavier than the sheet edge |
| `control` / `field` | Secondary button outline / input outline | `control` on an input (fails 3:1) |
| `text` / `muted` | Primary / secondary text. Two text greys only | Lighter greys for words |
| `primary` | The one filled button per screen (near-black) | Brand colour on buttons |
| `accent` (+`mark`, `mark-selected`, `accent-tag`) | Quoted spans in the ticket, the selected flag's edge, focus ring | Chrome, headings, links, buttons |
| `positive` / `negative` / `warning` + pill pairs | Status only (accepted, high severity, open) | Decoration; colour on a zero |

Rules:
- **Colour budget under 3% of the screen.** Colour is on data (the spans) and on status pills.
- Status is never colour alone: every pill carries its word.
- One status pill per row. A severity pill and a status pill are two different facts and may share
  a row; nothing else gets a pill.
- No raw Tailwind palette classes in components (`amber-*`, `emerald-*`, `slate-*`…). Tokens only.
- Contrast (computed): text tokens ≥ 4.8:1 on every surface; pill inks ≥ 6.8:1 on their tints;
  input borders 3.1–3.3:1; white on the primary 16.6:1.
- Light theme only for now; dark would be a second token set, not new components.

## 3. Typography Rules

| Role | Size / line height | Weight |
|---|---|---|
| Page title (h1, the ticket title) | 22 / 28 | 600 |
| Section title (Flags, Your gaps, Decision history) | 16 / 24 | 600 |
| Ticket reading text | 15 / 24, max 68ch | 400 |
| Body, nav, rows, buttons | 14 / 20 | 400 (500 on buttons, active tab) |
| Labels, meta, pills, timestamps | 12 / 16 | 400–500 |

- **One face: IBM Plex Sans.** Plex Mono has one job: ticket keys (`PAY-250`), IDs, Gherkin and
  scaffold code. Not for labels, step numbers or counts.
- App type, not display type: nothing over 22px; no figure at 48px.
- Tabular figures on every count, ratio and timestamp.
- **Sentence case everywhere.** No uppercase tracked labels, except at most one on a screen.
- No index numbering as decoration (no 01 / 02 / 03). Ordered things are real `<ol>` lists with
  plain numerals; steps are named in words.
- No glyphs or emoji as icons (no ✎ ◆ ◇); use the icon set (§4) with a word.
- Fonts: `@fontsource` latin woff2 files via `next/font/local` (no request to Google at build or
  runtime; `next/font/google` fails behind TLS-inspecting antivirus).
- Copy: active voice, second person, errors say what to do next; `…` not `...`.

## 4. Component Stylings

**Buttons** — radius 6, Plex Sans 500/14, one height per row.
- `primary`: `primary` fill, white label, 36px. **One per screen**, in the title row, for the
  current step's action (Start blind review → Lock N gaps → Mark ready for development).
- `secondary`: white, 1px `control` border, 32px.
- `quiet`: text only, `muted` → `text` and a `raised` fill on hover.
- `danger`: text or outline in `negative`; only for irreversible actions, always with a dialog.
- Pending: label changes to the "…ing" form, `disabled`, `aria-busy`. Phone: ≥ 44px tall.

**Links** — `text` colour, underline on hover only; inside running text underlined.

**Inputs** — white, 1px `field` border, radius 6, 38px (textarea free), label above at 14/500 with
8px gap; focus 2px `accent` ring; error = `negative` border + message below tied with
`aria-describedby`. No placeholder as a label.

**Pills** — 20px tall, radius 4, 12/500, a pale tint with dark ink of the same hue, `nowrap`.
- Severity: high = negative pair, medium = warning pair, low = neutral pair, word "High"/"Medium"/"Low".
- Flag / scenario status: Open = warning pair; Accepted = positive pair; Edited = accent-tag pair
  with `accent-ink`; Dismissed and Stale = neutral pair.
- Gap link: Matched = positive pair; Missed = neutral pair.

**Ticket text panel** — on the sheet, no card: a section title "Ticket", then Description as
paragraphs and Acceptance criteria as an `<ol>` (plain numerals in `muted`). Quoted spans:
`mark` background, 2px `accent` underline; the selected flag's span `mark-selected`. Each span has
an id so "Show in ticket" can jump to it. Sticky on desktop with its own scroll.

**Flag list** — the right column. Each flag is a row (min 56px): severity pill, category in
`muted`, the "what's unclear" line (one line, ellipsis), status pill at the right edge. Rows are
links that set `?flag=<id>` (server-rendered selection, works without JS). The selected row is
expanded in place on `raised` with a 2px `accent` left edge: why it matters, the quoted words with
"Show in ticket", the question for the PM in a white well, then the actions (Accept as secondary,
Edit wording, Dismiss as quiet; Reopen on decided flags). Default selection: the first open flag.

**Gap list** (blind stage) — numbered `<ol>` rows on `rule` lines, Remove as quiet; add-gap field
with label "Add a gap"; the Lock action is the title row's primary, behind a confirmation dialog.

**Gap links** (after lock) — rows: the gap text, a labelled select "Covered by", Save link
(secondary), Matched/Missed pill.

**Notices** — inline, inside the block they concern: a 1px border and pale tint of the pill pair,
one sentence, a text action. Errors `role="alert"`, success `role="status"`. No full-width banners
except the action error from `?error=` at the top of the sheet.

**Dialogs** — native `<dialog>` + `showModal()`, white, radius 8, `0 8px 24px rgb(0 0 0 / .12)`
(the only shadow in the system), title 16/600, consequence sentence, Cancel first (focused),
confirm second. Used for irreversible steps only (lock, complete session).

**Ledger** (decision history, readiness timeline, scenario history) — rows on `rule` lines; a
fixed timestamp column (12px, tabular, `muted`), actor, the decision as a pill, the detail.
**Timestamps stay UTC ISO** (`2026-10-25 14:02 UTC`).

**Empty / loading / error** — an empty block keeps its title and says one sentence in a 1px dashed
`border` box, radius 8. Loading (`loading.tsx`) is the final layout with flat `raised` bars at real
sizes, no shimmer. Route errors use `error.tsx` with retry.

**Icons** — `lucide-react`, 16px, stroke 1.5, `muted`, always beside a word or with `aria-label`:
nav items, Sign out, Show in ticket, Download, Edit. Never in a tinted square.

**Focus & hover** — every interactive element has a 2px `accent` `:focus-visible` ring with 2px
offset. Hover changes text or border colour, never only the fill.

**Motion** — feedback only, CSS, 120–150ms, `transform`/`opacity`/`color`/`border-color`, never
`transition: all`. Button press `translate-y-px`; dialog fades in. **Nothing performs an entrance**
(no reveal animations). `prefers-reduced-motion: reduce` removes all of it.

## 5. Layout Principles

**Shell (≥ 1024px)**
- Frame: sidebar 228px + top bar 48px on `frame`, no rule between.
- Sheet: starts at the sidebar's right edge and under the top bar, inset 8px from the window's
  right and bottom; 16px radius, 1px `border`, no shadow; content padding 24px.
- Sidebar (top to bottom): product mark + "SpecFix"; the workspace (name, role) with the switcher;
  nav — "Review queue" and the workspace's projects (from `listProjects`); bottom: the signed-in
  email and Sign out. Active item: `active` grey pill, radius 6, inset 8px, label unchanged.
- Top bar: the breadcrumb (project / `KEY`) aligned with the sheet's content edge; nothing else
  unless it is real.
- **Blind-first rule for the shell.** Before the reviewer's gap list is locked, nothing on the
  ticket page may read the flags table — not flags, not counts. So the sidebar shows no per-ticket
  flag counts. A sidebar list of tickets would need a ticket list without flag data, which no
  repository function provides today; adding one is a backend change and needs approval first.

**Ticket Review sheet**
1. Title row: h1 (ticket title, 22/600) and under it the finding line (14, `muted`); on the right,
   the one primary action for the current step.
2. Tabs: Review · Specs — 14px, 2px `text` underline running 8px past the label, on a 1px `border`
   rule across the sheet.
3. Optional action error (`?error=`) as a notice.
4. Two columns, 24px gap: ticket text `minmax(0,1fr)` | work column `440px` (blind stage: your gaps;
   after lock: flags, then gap links, then complete session).
5. Full width under both: decision history and readiness timeline as two ledgers side by side.

- One gutter value (24px) horizontally and vertically.
- Every block shares the sheet's content edges; no card stretched over empty space.
- The answer to "what do I still need to decide?" — the finding line, the open-flag count and the
  primary action — is on the first screen at 1280×800.

## 6. Depth & Elevation

- Level 0: `frame`.
- Level 1: the sheet (`sheet`, 1px `border`).
- Level 1b: `raised` fill for the selected row, wells and code (a tone step, no border).
- Floating: dialogs and menus only, with the one shadow.
Three levels at most: frame, sheet, one step inside it. No card inside a card.

## 7. Do's and Don'ts

Do
- Put the ticket text and the flags side by side; keep the span ↔ flag link visible.
- Show where the review stands in one sentence, with the next action beside it.
- Keep every action a real `<form>` posting the existing server action, or a real link; selection
  and edit modes in the URL (`?flag=`, `?edit=`).
- Use the product's own words ("Covered by", "Not raised by the model", "Mark ready for development").
- Show only real data; when a state can't be shown with real data, leave it unshown.

Don't
- Gradients, glows, glass, blobs, emoji, glyph icons, icons in tinted squares.
- Serif type, cream/paper grounds, terracotta/rust/vermilion, violet or indigo.
- Uppercase tracked labels, monospace labels, 01/02/03 step numbers.
- More than one filled button per screen; brand colour on buttons, tabs or nav.
- Wrap every block in a card; nest cards; shadows on anything at rest.
- Change server-action names, form field names, redirect targets or data fetching order.

## 8. Responsive Behavior

- **< 640 (phone):** the frame disappears; the sheet is the screen. A 48px top bar on `frame`:
  menu button (opens a full-screen sheet with the nav, workspace switcher and sign out), the ticket
  key, nothing else. Title 20px, then the finding line, then the primary action full width (44px).
  Ticket text collapses into a disclosure ("Ticket text", open before the review starts), then the
  work column full width. Ledgers become two-line rows (timestamp on line 2). Margins 16px.
- **640–1023 (tablet):** frame folds to the phone top bar; one column; ticket text above the work
  column.
- **1024–1279:** full shell (sidebar + sheet), still one column inside the sheet — two columns
  would leave the ticket text under 300px.
- **≥ 1280:** full shell, two columns (ticket text `1fr` | work column 440px), ticket text sticky.
- No horizontal page scroll at 360–1440px; long words, keys and quotes wrap (`break-words`,
  `min-w-0`); only code blocks scroll inside themselves.
- Touch targets ≥ 44px on phone; ≥ 24px everywhere (breadcrumb links included).
- Verified widths: 375×812, 768×1024, 1280×800, 1440×900.

## 9. Agent Prompt Guide

When changing `apps/web`:
1. Read this file first; it beats any skill's defaults.
2. Stack only: Next.js App Router server components, existing server actions, Tailwind 3 + CSS
   variables, `tailwind-merge` in `cn`, `lucide-react`. Client islands only for pending buttons,
   the confirm dialog, the phone menu.
3. Never touch `packages/*`, migrations, `lib/repos.ts`, `lib/supabase/*`, `lib/tenant.ts`,
   `middleware.ts`, or server-action contracts. Respect the blind-first rule (§5).
4. Inspect real screenshots at the four widths, fix, re-shoot.
5. Review changed files with `web-design-guidelines`; triage against the deviations below.

**Deviations, on purpose**
- From Vercel Web Interface Guidelines: sentence case, not Title Case; audit timestamps in UTC ISO,
  not locale formats (an audit trail read across time zones must not be ambiguous).
- From Taste Skill's framed-sheet sheet: inputs use `field` (#8c8f93) instead of `control` for
  their border, because #cdced1 is 1.57:1 and fails WCAG 1.4.11; the dealt teal moves from charts
  (SpecFix has none) onto the quoted spans and selected flag; Plex Mono also sets Gherkin and
  scaffold code (real code).
- Tailwind class names: the `accent` token is `teal-*` (`teal`, `teal-ink`, `teal-tag`) and the
  `muted` text token is `muted-foreground`, because the legacy `accent` / `muted` class names stay
  pale backgrounds for pages not yet redesigned. Rename once every page is on this design.
- Taste's inspector (`inspect.mjs`) cannot see signed-in pages; signed-in screens are checked with
  the browser pane or Playwright CLI instead.

**Tools** (installed at user level, `~/.claude/skills/`, plus the global `playwright-cli`)
- `web-design-guidelines` — review every changed page before showing it. Dated rules snapshot in
  its `references/`.
- `design-taste-frontend` — `lint.mjs --app` on changed files; the direction sheet is in this
  file, do not redeal without a reason.
- Awesome DESIGN.md (`~/design-references/awesome-design-md`) — format reference only.
- `image-to-code` — only with an approved reference image.
- `playwright-cli` — signed-in, repeatable screenshots:
  `playwright-cli -s=specfix open http://localhost:3000/login --browser=chrome --headed --persistent`
  (sign in once), then `resize <w> <h>` and `screenshot --full-page --filename=<name>.png` per width
  and state.
- Dev server on machines with HTTPS-scanning antivirus: the `web-system-ca` launch entry
  (`NODE_OPTIONS=--use-system-ca`).
