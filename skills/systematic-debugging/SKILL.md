---
name: systematic-debugging
license: MIT
description: "Use when encountering any bug, test failure, build failure, or unexpected behavior — before proposing fixes. Root cause first: investigate, compare patterns, test one hypothesis at a time, then fix with a failing test. Symptom patches without root cause are failure."
---

# Systematic Debugging

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue: test failures, production bugs, unexpected behavior, performance problems, build failures, integration issues.

**Use this ESPECIALLY when:**

- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**

- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- The user wants it fixed NOW (systematic is faster than thrashing)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings — they often contain the exact solution
   - Read stack traces completely; note line numbers, file paths, error codes
   - For type errors: `lsp_diagnostics` on the file or directory beats re-reading code

2. **Reproduce Consistently**
   - Can you trigger it reliably? What are the exact steps? Does it happen every time?
   - If not reproducible → gather more data, don't guess. For TUI/interactive behavior, drive a real terminal (tmux) instead of assuming

3. **Check Recent Changes**
   - What changed that could cause this? `git diff`, `git log`, `git log -S"<symbol>"`
   - New dependencies, config changes, environmental differences

4. **Gather Evidence in Multi-Component Systems**

   WHEN the system has multiple components (config resolution → launcher spawn → child process → output capture):

   **BEFORE proposing fixes, add diagnostic instrumentation:**

   ```
   For EACH component boundary:
     - Log what data enters the component
     - Log what data exits the component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify the failing component
   THEN investigate that specific component
   ```

   **Example (Node pipeline):**
   ```bash
   # Layer 1: env resolution
   node -e 'console.log("env keys:", Object.keys(process.env).filter(k=>k.startsWith("TORUS")).join(","))'
   # Layer 2: launcher argument passing
   node --experimental-strip-types runtime/bin/torus.mjs --version 2>&1 | head -5
   # Layer 3: spawned child stderr/stdout wiring
   # (add temporary stderr tee at the spawn boundary, run once, remove)
   ```

   **This reveals:** which layer fails (env ✓, resolution ✓, spawn ✗) instead of which layer you assumed.

5. **Trace Data Flow**

   WHEN the error is deep in a call stack: walk backward with `lsp_goto_definition` / `lsp_find_references` — where does the bad value originate? What called this with the bad value? Keep tracing up until you find the source. Fix at source, not at symptom.

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in the same codebase — what works that's similar to what's broken?
   - `torus_astgrep` finds structurally similar call sites; grep finds the obvious ones

2. **Compare Against References**
   - If implementing a known pattern, read the reference implementation COMPLETELY — every line, no skimming
   - Understand the pattern fully before applying

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small. Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need? What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Testing

**Scientific method:**

1. **Form Single Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Write it down. Be specific, not vague

2. **Test Minimally**
   - Make the SMALLEST possible change to test the hypothesis
   - One variable at a time. Don't fix multiple things at once

3. **Verify Before Continuing**
   - Did it work? Yes → Phase 4
   - Didn't work? Form a NEW hypothesis — DON'T add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X". Don't pretend to know — research more or ask

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Create Failing Test Case**
   - Simplest possible reproduction, automated in the repo's test framework (one-off script only if no framework fits)
   - MUST exist before fixing — a fix without a failing test is an opinion

2. **Implement Single Fix**
   - Address the root cause identified. ONE change at a time
   - No "while I'm here" improvements, no bundled refactoring

3. **Verify Fix**
   - The failing test passes now; no other tests broke; the issue is actually resolved
   - Run the repo's own gate before claiming success — the smallest check that proves the behavior (adjacent test file, typecheck), not just the one test you wrote

4. **If Fix Doesn't Work**
   - STOP. Count: how many fixes have you tried?
   - If < 3: return to Phase 1, re-analyze with the new information
   - **If ≥ 3: STOP and question the architecture (below) — don't attempt fix #4**

5. **If 3+ Fixes Failed: Question Architecture**

   Pattern indicating an architectural problem:

   - Each fix reveals new shared state/coupling in a different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   STOP and question fundamentals: Is this pattern fundamentally sound? Are we sticking with it through sheer inertia? Should the architecture change instead of another symptom patch? Discuss with the user before attempting more fixes. This is NOT a failed hypothesis — this is a wrong architecture.

## Red Flags — STOP and Follow Process

If you catch yourself thinking:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals a new problem in a different place**

**ALL of these mean: STOP. Return to Phase 1.**

## User Signals You're Doing It Wrong

Watch for these redirections:

- "Is that not happening?" — you assumed without verifying
- "Will it show us...?" — you should have added evidence gathering
- "Stop guessing" — you're proposing fixes without understanding
- "We're stuck?" (frustration) — your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write the test after confirming the fix works" | Untested fixes don't stick. The test proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question the pattern, don't fix again. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create failing test, fix, verify | Bug resolved, tests pass |

## When Process Reveals "No Root Cause"

If systematic investigation reveals the issue is truly environmental, timing-dependent, or external:

1. You've completed the process — document what you investigated
2. Implement appropriate handling (retry, timeout, error message)
3. Add logging/monitoring for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.
