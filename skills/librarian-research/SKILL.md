---
name: librarian-research
description: "Deep research playbooks for the librarian agent: documentation discovery via sitemaps, per-request-type tool sequences (conceptual / implementation / context / comprehensive), GitHub permalink construction, parallel batch sizes, and failure recovery. Load when researching external libraries, remote repos, or OSS usage examples beyond a quick lookup."
---

# librarian-research

Full playbooks backing the librarian agent (`agents/librarian.md`). Tool truth: docs lookup is `mcp__context7__resolve_library_id` → `mcp__context7__query_docs`, code search is `mcp__grep_app__searchGitHub`, web is `web_search` / `fetch_content` (fallback `bash: curl -sL`). `gh` commands are the convenience form — `git clone` + `curl` always work. Clones go under `/tmp/torus-librarian/`.

## PHASE 0.5: DOCUMENTATION DISCOVERY (FOR TYPE A & D)

**When to execute**: Before TYPE A or TYPE D investigations involving external libraries/frameworks.

### Step 1: Find Official Documentation
```
web_search("library-name official documentation site")
```
- Identify the **official documentation URL** (not blogs, not tutorials)
- Note the base URL (e.g., `https://docs.example.com`)

### Step 2: Version Check (if version specified)
If user mentions a specific version (e.g., "React 18", "Next.js 14", "v2.x"):
```
web_search("library-name v{version} documentation")
// OR check if docs have version selector:
fetch_content(official_docs_url + "/versions")
// or
fetch_content(official_docs_url + "/v{version}")
```
- Confirm you're looking at the **correct version's documentation**
- Many docs have versioned URLs: `/docs/v2/`, `/v14/`, etc.

### Step 3: Sitemap Discovery (understand doc structure)
```
fetch_content(official_docs_base_url + "/sitemap.xml")
// Fallback options:
fetch_content(official_docs_base_url + "/sitemap-0.xml")
fetch_content(official_docs_base_url + "/docs/sitemap.xml")
```
- Parse sitemap to understand documentation structure
- Identify relevant sections for the user's question
- This prevents random searching-you now know WHERE to look

### Step 4: Targeted Investigation
With sitemap knowledge, fetch the SPECIFIC documentation pages relevant to the query:
```
fetch_content(specific_doc_page_from_sitemap)
mcp__context7__query_docs(libraryId: id, query: "specific topic")
```

**Skip Doc Discovery when**:
- TYPE B (implementation) - you're cloning repos anyway
- TYPE C (context/history) - you're looking at issues/PRs
- Library has no official docs (rare OSS projects)

## PHASE 1: EXECUTE BY REQUEST TYPE

### TYPE A: CONCEPTUAL QUESTION
**Trigger**: "How do I...", "What is...", "Best practice for...", rough/general questions

**Execute Documentation Discovery FIRST (Phase 0.5)**, then:
```
Tool 1: mcp__context7__resolve_library_id("library-name")
        → then mcp__context7__query_docs(libraryId: id, query: "specific-topic")
Tool 2: fetch_content(relevant_pages_from_sitemap)  // Targeted, not random
Tool 3: mcp__grep_app__searchGitHub(query: "usage pattern", language: ["TypeScript"])
```

**Output**: Summarize findings with links to official docs (versioned if applicable) and real-world examples.

### TYPE B: IMPLEMENTATION REFERENCE
**Trigger**: "How does X implement...", "Show me the source...", "Internal logic of..."

**Execute in sequence**:
```
Step 1: Clone to temp directory
        git clone --depth 1 https://github.com/owner/repo /tmp/torus-librarian/repo-name

Step 2: Get commit SHA for permalinks
        cd /tmp/torus-librarian/repo-name && git rev-parse HEAD

Step 3: Find the implementation
        - grep or the ast-grep skill for function/class
        - read the specific file
        - git blame for context if needed

Step 4: Construct permalink
        https://github.com/owner/repo/blob/<sha>/path/to/file#L10-L20
```

**Parallel acceleration (4+ calls)**:
```
Tool 1: git clone --depth 1 https://github.com/owner/repo /tmp/torus-librarian/repo
Tool 2: mcp__grep_app__searchGitHub(query: "function_name", repo: "owner/repo")
Tool 3: gh api repos/owner/repo/commits/HEAD --jq '.sha'
Tool 4: mcp__context7__query_docs(libraryId: id, query: "relevant-api")
```

### TYPE C: CONTEXT & HISTORY
**Trigger**: "Why was this changed?", "What's the history?", "Related issues/PRs?"

**Execute in parallel (4+ calls)**:
```
Tool 1: gh search issues "keyword" --repo owner/repo --state all --limit 10
Tool 2: gh search prs "keyword" --repo owner/repo --state merged --limit 10
Tool 3: git clone --depth 50 https://github.com/owner/repo /tmp/torus-librarian/repo
        → then: git log --oneline -n 20 -- path/to/file
        → then: git blame -L 10,30 path/to/file
Tool 4: gh api repos/owner/repo/releases --jq '.[0:5]'
```

**For specific issue/PR context**:
```
gh issue view <number> --repo owner/repo --comments
gh pr view <number> --repo owner/repo --comments
gh api repos/owner/repo/pulls/<number>/files
```

### TYPE D: COMPREHENSIVE RESEARCH
**Trigger**: Complex questions, ambiguous requests, "deep dive into..."

**Execute Documentation Discovery FIRST (Phase 0.5)**, then execute in parallel (6+ calls):
```
// Documentation (informed by sitemap discovery)
Tool 1: mcp__context7__resolve_library_id → mcp__context7__query_docs
Tool 2: fetch_content(targeted_doc_pages_from_sitemap)

// Code Search
Tool 3: mcp__grep_app__searchGitHub(query: "pattern1", language: [...])
Tool 4: mcp__grep_app__searchGitHub(query: "pattern2", useRegexp: true)

// Source Analysis
Tool 5: git clone --depth 1 https://github.com/owner/repo /tmp/torus-librarian/repo

// Context
Tool 6: gh search issues "topic" --repo owner/repo
```

## PERMALINK CONSTRUCTION

```
https://github.com/<owner>/<repo>/blob/<commit-sha>/<filepath>#L<start>-L<end>

Example:
https://github.com/tanstack/query/blob/abc123def/packages/react-query/src/useQuery.ts#L42-L50
```

**Getting SHA**:
- From clone: `git rev-parse HEAD`
- From API: `gh api repos/owner/repo/commits/HEAD --jq '.sha'`
- From tag: `gh api repos/owner/repo/git/refs/tags/v1.0.0 --jq '.object.sha'`

## TOOL REFERENCE

- **Official Docs**: Use context7 - `mcp__context7__resolve_library_id` → `mcp__context7__query_docs`
- **Find Docs URL**: Use `web_search("library official documentation")`
- **Sitemap Discovery**: Use `fetch_content(docs_url + "/sitemap.xml")` to understand doc structure
- **Read Doc Page**: Use `fetch_content(specific_doc_page)` for targeted documentation
- **Latest Info**: Use `web_search("<query>")`
- **Fast Code Search**: Use grep_app - `mcp__grep_app__searchGitHub(query, language, useRegexp)`
- **Deep Code Search**: Use gh CLI - `gh search code "query" --repo owner/repo`
- **Clone Repo**: Use `git clone --depth 1 https://github.com/owner/repo /tmp/torus-librarian/name`
- **Issues/PRs**: Use gh CLI - `gh search issues/prs "query" --repo owner/repo`
- **View Issue/PR**: Use gh CLI - `gh issue/pr view <num> --repo owner/repo --comments`
- **Release Info**: Use gh CLI - `gh api repos/owner/repo/releases/latest`
- **Git History**: Use git - `git log`, `git blame`, `git show`

## PARALLEL EXECUTION REQUIREMENTS

- **TYPE A (Conceptual)**: Suggested Calls 1-2 - Doc Discovery Required YES (Phase 0.5 first)
- **TYPE B (Implementation)**: Suggested Calls 2-3 - Doc Discovery Required NO
- **TYPE C (Context)**: Suggested Calls 2-3 - Doc Discovery Required NO
- **TYPE D (Comprehensive)**: Suggested Calls 3-5 - Doc Discovery Required YES (Phase 0.5 first)

**Doc Discovery is SEQUENTIAL** (web_search → version check → sitemap → investigate).
**Main phase is PARALLEL** once you know where to look.

**Always vary queries** when using grep_app:
```
// GOOD: Different angles
mcp__grep_app__searchGitHub(query: "useQuery(", language: ["TypeScript"])
mcp__grep_app__searchGitHub(query: "queryOptions", language: ["TypeScript"])
mcp__grep_app__searchGitHub(query: "staleTime:", language: ["TypeScript"])

// BAD: Same pattern
mcp__grep_app__searchGitHub(query: "useQuery")
mcp__grep_app__searchGitHub(query: "useQuery")
```
