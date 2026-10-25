---
name: site-design
description: "Re-imagining or reworking the visual design of a project's site (landing, docs, changelog): design direction grounded in the product's own world, a checklist of generated-looking defaults to design against, and evidence rules (real captures over mockups, machine-derived numbers). Use when restyling a site, redesigning a page, planning a visual direction, or critiquing a design pass."
---

# site-design

The ecosystem's design skills agree on what separates a designed page from an
assembled one. This skill folds that guidance into one portable method: it
assumes nothing about the stack, works for a landing on GitHub Pages or any
static host, and defers build and toolchain rules to the repo that owns the
site.

## Ground the design in the subject

- Identify the product and its audience's world before any visual choice: the
  design language comes from that world, not from the marketing-site genre. A
  terminal tool points at monospace discipline, statusline vocabulary, and the
  ANSI palette; a data pipeline points at flow diagrams and unit notation; find
  the equivalent for this product and borrow its vernacular.
- Inventory what only this project has: real artifacts (terminal captures,
  screenshots, output, diffs), machine-derived numbers (commit counts,
  benchmarks, release cadence), named internal concepts users meet in the first
  five minutes, and the one story the product tells best. Every image, number,
  and color choice should trace back to this list.
- Run the competitor test: drop the nearest real competitor's name into the
  page. If it still reads true, there is no idea yet; "clean and modern" is not
  an idea.
- Where the product can demonstrate itself, it should: a real interface
  fragment at true size is the strongest picture a software page can carry, and
  a claim the page can prove beats an adjective.

## Process: claims, tokens, build, verify

1. **Claims before layout.** Write the page as claims, each with its proof on
   the same screen: a capture, a number with its derivation, or a command.
   Sections without a claim get deleted; the argument's order replaces the
   stock section order.
2. **Token plan before code.** One compact plan: 4-6 named hex values per theme
   and their roles; type roles (one family, or two that are clearly distinct);
   a layout concept as one sentence plus an ASCII wireframe; three principles
   naming what makes this page unlike any other. Review the plan against the
   tells checklist below before writing code: anything you would have produced
   for a different product gets redesigned now, while it costs a sentence.
3. **Build complete at first paint.** The page is whole with styles and scripts
   off; motion never rescues a layout. Entrances move what is already there.
4. **Verify the render.** Build, then screenshots at the sizes the site ships
   at, in both themes, with reduced motion on. Fix in batches; two look-fix
   rounds is the ceiling. Delegate screenshot critique to a vision-capable
   agent when a question depends on seeing the page. For a final audit pass,
   fetch the current Web Interface Guidelines (vercel-labs) and check the
   rendered pages against them.

## Principles

- **The product demonstrating itself is the hero.** A real capture or
  screenshot at true size, cropped to the part that makes the point, square
  corners, no browser or device frame. One dominant image (at least half the
  first viewport) beats six small ones.
- **Type: contrast through size, not weight.** Display at roughly 4x body or
  more; regular weight is allowed at display size; 3-5 sizes set far apart;
  body measure 45-75ch on the paragraph, not the page. Never bold everything.
- **Color is proportion, not tint.** 70-90% ground; running text at full ink;
  accent under 5% of any screen, spent on the action plus at most one recurring
  thing. Structure comes from space and tone steps (one 2-6 point surface step,
  hard field edges), never from borders, shadows, or card kits.
- **Dark mode is a redesign, not an inversion.** Tinted deep ground, soft-light
  ink, lighter weights, a lighter surface standing in for elevation, a
  desaturated accent. State contrast parity: borders, focus, disabled, and
  selection states verified in both themes, since the theme that gets all the
  attention is the one that ships broken.
- **Theme the browser-owned surfaces.** Selection, caret, scrollbars, focus
  rings, underline offset, tabular numerals in stats all ship with defaults
  belonging to no design system. Themed from the palette, they are the cheapest
  signal that a page was built rather than assembled, and the part models skip
  most reliably.
- **Motion is a budget.** One signature moment (a capture replaying, a graph
  drawing itself); entrances elsewhere staggered 60-90ms, rising 16-32px,
  firing once below the fold; transform and opacity only; exits run at roughly
  60-70% of entrance duration. Respect prefers-reduced-motion in every entrance
  effect.
- **Placed space, not holes.** Every large void is a rest closed by the
  picture, the type, or a tone step; more than ~40% of a screen of plain ground
  is a hole. The gap between sections exceeds the gap within a section.
- **Numbers earn trust mechanically.** Totals computed from the rows they
  summarize; deltas carry baseline and window; the derivation sits where the
  number is read. Only numbers a machine source produced; never type a count
  into copy by hand.
- **Copy is a design decision.** Plain verbs, active voice, a CTA that names
  its action, the same word for the same action everywhere. Delete adjectives
  the evidence already proves.

## Tells: the generated-default checklist

These traits are defaults, not bans: use one only when it is a deliberate
choice for this brief. Audit the existing page against this list too: inherited
traits that were never chosen are the first things to redesign.

- Cream ground near `#F4F1EA`, high-contrast serif display, terracotta or clay accent.
- Near-black ground with a single acid-green or vermilion accent.
- Broadsheet layout: hairline rules, zero border radius, newspaper columns.
- The SaaS card kit: identical rounded cards, one radius everywhere, the same
  soft shadow under each, gradient washes as decoration.
- Template chrome: tracked-out all-caps eyebrow labels, meta strings joined
  with middle dots, labels built as `WORD — fragment`, tinted near-black
  standing in for black, monospace reserved for small data labels, an arrow
  appended to link text.
- Accenting one word or phrase in a headline (italic, bold, or color).
- Numbered markers where the content is not actually a sequence.
- Fade-and-slide-up entrance on every section; hover transitions on every card.
- A big number with a small label and a gradient accent as the default stat
  treatment.

## Evidence rules

- Terminal figures and screenshots are captures of real sessions, never
  mockups or skins. Regenerate them with the repo's own capture tooling when
  content changes, and keep any redaction that tooling applies intact.
- Numbers, graphs, and version strings stay machine-derived: generated at build
  time from the repo, never retyped into copy. If a number cannot be generated,
  cut it or say where it came from.
- The build and deploy are part of the design surface: find the repo's site
  conventions (AGENTS.md, site README, or the build script) and design within
  them, including constraints like inlined fonts, no client frameworks, or
  generated stats from git history.
- This skill owns the design method, not the build rules; when the two
  conflict, the repo's conventions file wins and the design adapts.
- Both color schemes are first-class; the accessibility floor is not
  negotiable: visible keyboard focus, contrast, reduced motion, responsive down
  to mobile.

## Verify

- The repo's own build and preview commands (from its AGENTS.md or
  package.json), plus its lint and any site tests
- Screenshots: both themes at roughly 390, 768, and 1440px wide, plus a
  reduced-motion pass; critique them against the tells checklist before calling
  the work done
- If the site derives stats at build time, a clean build from a fresh clone is
  the proof the numbers are machine-derived

## Sources

Folded in from the ecosystem's design skills (mined October 2026, installed
temporarily, distilled here so the repo carries its own):

- anthropics/skills `frontend-design`: tells list, two-pass process, writing in design.
- leonxlnx/taste-skill `design-taste-frontend`: inventory-first, competitor test, color proportion, placed space, motion budget.
- pbakaus/impeccable: persuade mode, craft floor, browser-owned surfaces, batched render checks.
- wondelai/skills `refactoring-ui`: hierarchy levers, shade scales, dark mode as redesign.
- emilkowalski/skills `apple-design` and `animation-vocabulary`: named motion techniques, tabular numerals.
- nextlevelbuilder/ui-ux-pro-max-skill: state contrast parity, motion timing as tokens.
- vercel-labs/agent-skills `web-design-guidelines`: the fetched-rules audit pass.
- google-labs-code/stitch-skills `design-md` and arvindrk/extract-design-system: design-spec formats worth borrowing when the token plan needs a home.
