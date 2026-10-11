---
name: technical-writing
description: "Writes and reviews technical prose: documentation, READMEs, guides, changelog entries, PR descriptions, design notes. Use when creating or editing docs, reviewing prose for clarity and structure, or when asked to make writing tighter, clearer, or less generated-sounding."
---

# technical-writing

Rules for producing and auditing technical prose, adapted from the Vercel writing handbook (github.com/vercel-labs/writing-guidelines) and Google's technical-writing courses (developers.google.com/tech-writing) plus its developer documentation style guide (developers.google.com/style). Two modes: WRITE when producing prose, REVIEW when auditing files.

## When to load

- Creating or substantially editing documentation, READMEs, guides, or design notes
- Writing PR descriptions, release notes, or commit messages meant for humans
- Reviewing a documentation change, or auditing a docs surface
- A reader says the prose is unclear, padded, or reads like it was generated

## Ground truth first

Before writing or reviewing in a repository, look for its own style rules. Local rules win wherever they conflict with this skill:

- Style guides: a `docs/style.md` or equivalent, or style pointers in `AGENTS.md`, `CONTRIBUTING.md`, or the README
- Lint configs: `.markdownlint*`, `vale.ini`, `.textlintrc*`; enforced conventions reveal the house style even where no guide exists
- Existing pages: match the terminology, heading depth, and table conventions the repo already uses

This skill is the universal floor. Repositories extend and override it; when they do, follow the repository.

## WRITE mode

### Voice

- Active voice. Test: if the sentence still parses after appending "by monkeys", rewrite it.
- Address the reader directly: "you", never "the user".
- Imperative for steps: "Run the tests", not "You will need to run the tests".
- Present tense unless describing future behavior.
- Sentences under 20 words. If you re-read a sentence to parse it, split it.
- Contractions where they warm the tone.

### Terminology

- One concept, one name. Renaming a term mid-document breaks the reader the way renaming a variable breaks the compiler. Introduce a short form once, then keep it.
- Define unfamiliar terms at first use: link to an existing explanation when one exists, define inline when this page introduces the term.
- Spell out an acronym on first use with the acronym in parentheses. Do this only for acronyms that are much shorter and appear many times; never cycle between the full term and the acronym.
- Replace ambiguous pronouns (it, they, this, that) with the noun, or put a noun directly after "this" or "that". If the referent sits far away, repeat the noun.

### Ordering

- Put the key point first: every page opens with a one-paragraph summary of what it covers; every section opens with its conclusion or a summary sentence.
- Put conditions before instructions: "If the build fails, check the logs", not "Check the logs if the build fails".

### Words to cut

- Filler: `easy`, `simple`, `quick`, `just`, `very`, `really`, `simply`. Replace with the concrete fact, or delete.
- Superlatives (best, fastest) and absolutes (`never`, `always`, `guarantee`, `ensure`) unless the claim is truly unconditional.
- Weasel quantifiers where a number or specific claim fits: significantly, many, often, typically.
- Rhetorical questions. They read as marketing.

### Punctuation

- No em dashes as prose punctuation. Use colons, commas, semicolons, periods, or parentheticals.
- Serial commas: "a, b, and c".
- No filler ellipses in finished prose.

### Claims and time

- Document only what exists today. Do not pre-announce features; when behavior changes, change the docs in the same change.
- No performance or cost claims without a source the reader can verify.
- Security features "help prevent" or "are designed to" a threat; they never "prevent" it absolutely.
- Write timelessly: avoid "recently", "soon", and hand-written verification dates. History carries the when; docs carry the what.

### Structure

- Headings sentence case and descriptive enough to guess the content ("Caveats when self-hosting", not "Notes").
- Paragraphs 2 to 4 sentences, one idea each. Split anything longer or covering two ideas.
- Reference material organizes by surface (every flag, every env var); task material organizes by reader goal.
- Lists: bulleted for unordered items, numbered for sequences (rearranging a numbered list must change its meaning). Start numbered items with imperative verbs. Keep items parallel in grammar, category, capitalization, and punctuation. Introduce every list with a colon.
- Bold-term lists for definitions: "- **Term**: description".
- Tables for reference-shaped material (flags, options, comparisons). Label columns; keep cells under two sentences; keep columns parallel in type.

### Code blocks

- Language tag on every fenced block; `text` when nothing fits.
- Explain each block in prose before or after it; never drop and run.
- Short snippets with prose between them beat one long block.
- Inline code for paths, commands, identifiers, and anything that looks wrong without a monospace font.

### Emphasis and links

- Bold marks UI elements and critical facts, never emphasis. Reaching for bold for tone means the sentence is weak: rewrite it.
- Link anchor text names the destination. No bare URLs, no "here".

### AI tells

Generated-sounding prose shares tells; strip them:

- Recap transitions that open a paragraph by summarizing the last one ("With this setup complete...", "Now that we've explored..."). Pivot straight to the point.
- Stop-start fragments chopping one idea into three sentences for rhythm.
- Spec-sheet voice ("provides", "is configurable") where an action verb fits.
- Cold-open paragraphs whose first sentence has no antecedent.
- Personified artifacts: machines do not hand, carry, or land things.
- Template framing reused regardless of content ("The question most teams face is...").

## REVIEW mode

Read the target file(s) in full before writing any finding. Check every rule above, then output findings grouped by file, one per line, `file:line` format, terse: name the rule and quote the minimal span. Skip explanation unless the fix is non-obvious. Close with the highest-impact fixes ranked, at most five.

```text
docs/getting-started.md

docs/getting-started.md:3 - opening paragraph is a recap of the README; replace with a one-paragraph summary of this page
docs/getting-started.md:21 - filler "simply"; delete
docs/getting-started.md:34 - passive voice ("the config is written..."); name the actor
docs/getting-started.md:52 - em dash as punctuation; colon or split
docs/getting-started.md:71 - code block missing language tag; `sh`

docs/overview.md

docs/overview.md:12 - acronym "CRDT" used before definition
docs/overview.md:88 - paragraph covers two ideas (setup + billing); split

Top fixes: 3 (voice), 52 (punctuation), 88 (structure).
```

A file with no findings gets one line: the path, then "pass".
