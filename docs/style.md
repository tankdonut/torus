# Documentation style

torus docs follow one rubric, adapted from the Vercel writing handbook and Google's technical-writing courses and developer documentation style guide. `tests/docs-style.test.mjs` enforces the mechanical rules below; `markdownlint` (part of `npm run lint`) enforces the structural ones. This page is the source of truth for both. Deviations on purpose: straight quotes (git and code context), plain markdown (no frontmatter), no non-breaking spaces, and no em dashes in prose (Google permits them; we ban them for scanning consistency and to avoid generated-text tells).

Generated files are exempt where the machine owns the bytes: `CHANGELOG.md` (release-please) and, outside markdown entirely, `docs/efficiency.html` and `docs/bench-records.json` (bench renderer output). `docs/efficiency.md` is hand-maintained: its pasted bench numbers are exempt from the repo's no-hand-written-numbers rule, but its prose follows this rubric like any other page.

## Voice

- Active voice. Test: if the sentence still parses after appending "by monkeys", rewrite it.
- Address the reader directly: "you", never "the user".
- Imperative for steps: "Run `./make.sh check`", not "You will need to run ...".
- Present tense unless describing future behavior.
- Sentences under 20 words. If you re-read a sentence to parse it, split it.
- Contractions where they warm the tone.

## Terminology

- One concept, one name. Once you've named a component, do not rename it mid-document; renaming a term halfway through breaks the reader the way renaming a variable breaks the compiler. Introduce a short form once ("the catalog") and stick to it.
- Define unfamiliar terms at first use: link to an existing explanation if one exists, define inline if this page is introducing the term, collect many new definitions into a glossary.
- Spell out an acronym on first use, with the acronym in parentheses. Only do this for acronyms that are much shorter and appear many times; never cycle between the full term and the acronym.
- Replace ambiguous pronouns (it, they, this, that) with the noun, or put a noun directly after "this"/"that". If the referent is more than a handful of words away, repeat the noun.

## Ordering

- Put conditions before instructions: "If the directory has no `AGENTS.md`, read `CLAUDE.md`", not "Read `CLAUDE.md` if ...".

## Banned words and punctuation

- No `easy`, `simple`, `quick`, `just`, `very`, `really`, `simply`. (test-enforced; quoted counterexamples are allowlisted)
- No superlatives ("best", "fastest", "simplest") and no "never"/"always"/"guarantee"/"ensure" unless the claim is truly unconditional. Security features "help prevent" or "are designed to"; they never "prevent" absolutely.
- No weasel quantifiers ("significantly", "many", "often", "typically") where a concrete fact fits.
- No rhetorical questions.
- No em dashes as prose punctuation; use colons, commas, semicolons, periods, or parentheticals. (test-enforced; code spans and output-grammar tokens are exempt)
- Use serial (Oxford) commas: "a, b, and c".

## Claims and time

- Document only what ships. Do not pre-announce features; write as if the current behavior is the only behavior. When behavior changes, change the docs in the same PR.
- No performance or cost claims without a verifiable source the reader can check; the repo rule against hand-written numbers covers the common case.
- Write timelessly: avoid "recently", "soon", "new", and hand-written verification dates. Git history carries the when; docs carry the what.

## AI tells to eliminate

- No summary-recap transitions ("With this setup complete ...", "Now that we've explored ...").
- No stop-start fragments splitting one idea into choppy sentences.
- No spec-sheet voice ("provides", "is configurable") where an action verb fits.
- No cold-open paragraphs whose first sentence has no antecedent.
- No personified artifacts ("hand the browser a URL").
- No template framing ("The question most teams face is ...").

## Structure

- Every page opens with a one-paragraph summary of what it covers.
- Headings sentence case and descriptive enough to guess the content ("Caveats when self-hosting", not "Notes").
- Paragraphs 2 to 4 sentences, one idea per paragraph.
- Reference docs organized by surface; task docs by reader task.
- Three or more list-shaped items in prose: convert to a list. Introduce lists with a colon.
- Bulleted lists for unordered items (rearranging them must not change the meaning); numbered lists for ordered ones (rearranging changes the meaning). Start numbered items with imperative verbs.
- Keep list items parallel: same grammar, same logical category, same capitalization, same punctuation. Sentence items end with a period; fragments do not.
- Bold-term lists: "- **Term**: description".
- Tables for reference material (flags, env vars, tools, differences) instead of prose walls. Label every column with a meaningful header; keep cells under two sentences, or move the content out of the table; keep columns parallel in type.
- Acronyms spelled out on first use; terms defined before use.

## Code blocks

- Language tag on every fenced block. (markdownlint-enforced)
- Explain each block in prose; never drop and run.
- Keep snippets short; put prose between blocks.

## Emphasis and inline

- Bold for UI elements and critical facts only, never for emphasis.
- Inline code for paths, commands, and identifiers.
- Link anchor text names the destination; no bare URLs or "here".

## Facts and links

- No hand-written numbers duplicating a machine source of truth; reference the authoritative file instead (`package.json`, `agents/`, the coverage gate). (repo rule, see AGENTS.md)
- Relative links must resolve. (test-enforced)
- In the README, the pi-package install leads the Quickstart ahead of the from-source clone; flip both together when npm publishing arrives. (test-enforced)

## Renamed vocabulary

The session keyword gates are `deepwork`, `blueprint`, and `team`. The retired names must not reappear in docs. (test-enforced)
