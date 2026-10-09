---
name: torus-lsp-setup
description: "Diagnose and fix LSP tooling when lsp_* tools fail or a language is unsupported: map the file type to a language server, check PATH, install with permission, configure .pi/lsp-client.json, verify with lsp_diagnostics. Use when an lsp_ tool errors, returns nothing for a known language, or the user asks to set up, pick, or disable a language server."
---

# torus-lsp-setup

The LSP tools come from pi-lsp-client (the engine's pinned dependency). A tool works only when a language server for the file's language is installed and on PATH. This skill turns a dead LSP tool into a working one.

Source of truth for built-in servers: `node_modules/pi-lsp-client/src/lsp/server-definitions.ts` — `BUILTIN_SERVERS` (id, command, extensions), `LSP_INSTALL_HINTS`, `AUTO_INSTALLABLE_SERVERS`. When the table below and that file disagree, the file wins.

## Flow

1. **Identify the language** from the failing file's extension. Server id in backticks; the executable to check is the first token of its command.

   | Extensions | Server (default pick) | Install |
   |---|---|---|
   | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.mts` `.cts` | `typescript` (`typescript-language-server`) | `npm i -g typescript-language-server typescript` |
   | `.vue` | `vue` (`vue-language-server`) | `npm i -g @vue/language-server` |
   | `.svelte` | `svelte` (`svelteserver`) | `npm i -g svelte-language-server` |
   | `.astro` | `astro` (`astro-ls`) | `npm i -g @astrojs/language-server` |
   | `.go` | `gopls` | `go install golang.org/x/tools/gopls@latest` |
   | `.py` `.pyi` | `basedpyright` (`basedpyright-langserver`) | `pip install basedpyright` |
   | `.rs` | `rust` (`rust-analyzer`) | `rustup component add rust-analyzer` |
   | `.c` `.cpp` `.cc` `.cxx` `.h` `.hpp` `.hh` `.hxx` | `clangd` | system package — clangd.llvm.org/installation |
   | `.java` | `jdtls` | github.com/eclipse-jdtls/eclipse.jdt.ls releases |
   | `.kt` `.kts` | `kotlin-ls` (`kotlin-lsp`) | github.com/Kotlin/kotlin-lsp |
   | `.cs` | `csharp` (`csharp-ls`) | `dotnet tool install -g csharp-ls` |
   | `.fs` `.fsi` `.fsx` | `fsharp` (`fsautocomplete`) | `dotnet tool install -g fsautocomplete` |
   | `.swift` | `sourcekit-lsp` | ships with Xcode / Swift toolchain |
   | `.rb` `.rake` `.gemspec` `.ru` | `ruby-lsp` — runs `rubocop --lsp` | `gem install rubocop` |
   | `.php` | `php` (`intelephense`) | `npm i -g intelephense` |
   | `.dart` | `dart` (`dart language-server --lsp`) | included with the Dart SDK |
   | `.ex` `.exs` | `elixir-ls` | github.com/elixir-lsp/elixir-ls |
   | `.zig` `.zon` | `zls` | github.com/zigtools/zls |
   | `.lua` | `lua-ls` (`lua-language-server`) | github.com/LuaLS/lua-language-server |
   | `.sh` `.bash` `.zsh` `.ksh` | `bash-ls` (`bash-language-server`) | `npm i -g bash-language-server` |
   | `.yaml` `.yml` | `yaml-ls` (`yaml-language-server`) | `npm i -g yaml-language-server` |
   | `.tf` `.tfvars` | `terraform` (`terraform-ls`) | github.com/hashicorp/terraform-ls |
   | `.hs` `.lhs` | `haskell-language-server` | `ghcup install hls` |
   | `.ml` `.mli` `.tex` `.nix` `.gleam` `.clj` `.typ` `.prisma`, Dockerfile | `ocaml-lsp` `texlab` `nixd` `gleam` `clojure-lsp` `tinymist` `prisma` `dockerfile` | see `server-definitions.ts` |

   Built-in alternatives covering the same extensions: `.ts` also matches `deno`, `biome`, `eslint`, `oxlint`; `.py` also matches `pyright`, `ty`, `ruff`. Exactly one server serves an extension — see resolution below.

2. **Check**: `which <executable>` via bash. Present → skip to step 4.
3. **Install — ask first.** Installing is a global machine change: state the exact command, get the user's go-ahead, run it via bash, re-check `which`.
4. **Verify**: run `lsp_diagnostics` on the original file. Empty or real diagnostics = working; a server error = keep diagnosing (run `<executable> --version`, check the file is in a real project root).
5. **Configure only when needed**: picking between competing servers, custom flags, initialization options, timeouts — see below. Then `/reload` or restart the session and re-verify.

## How a file's server is chosen

Resolution walks servers in this order and picks the **first entry whose extensions match AND whose executable is installed**:

1. entries from `.pi/lsp-client.json` (project root) — sorted by `priority` descending
2. entries from `~/.pi/lsp-client.json` (user) — sorted by `priority` descending
3. built-ins, last, in definition order (so `typescript` wins `.ts` and `basedpyright` wins `.py` by default)

Consequences:

- One server per extension. Installing two matching servers does not run both — the earlier one in the order above silently wins.
- A default is only a default while its binary exists: if `typescript-language-server` is absent but `biome` is installed, `.ts` routes to `biome` without any config.
- To pin a choice deterministically, disable the ids you do not want (config below) — do not rely on install state.

## Config: .pi/lsp-client.json

Project file `.pi/lsp-client.json` at the repo root; user file `~/.pi/lsp-client.json`. Project entries override user entries with the same id; both override built-ins.

```jsonc
{
  "lsp": {
    "<id>": {
      "command": ["<executable>", "--stdio"],
      "extensions": [".ext"],
      "priority": 100,
      "initialization": {},
      "env": { "KEY": "value" },
      "requestTimeoutMs": 30000,
      "initTimeoutMs": 120000,
      "disabled": false
    }
  }
}
```

Rules enforced by pi-lsp-client's config loader:

- An entry is honored only with **both** `command` and `extensions`. Anything else is silently dropped — `{"typescript": {"priority": 100}}` does nothing. Overriding a built-in id means redefining it fully, command and extensions included.
- The exception is `disabled: true`, which works alone from either file and removes that id — built-ins included — from resolution.
- `priority` only sorts entries within the same file; it never lifts an entry above a more-configured source.
- Defaults: request timeout 15 s, init timeout 60 s. Slow servers (first index of a big repo): raise `initTimeoutMs`.

### Common swaps

| Want | Do |
|---|---|
| Deno to serve `.ts` | install `deno`, disable `typescript` |
| Biome as the only `.ts` server | `npm i -g @biomejs/biome`, disable `typescript` |
| `pyright` instead of `basedpyright` | install it, disable `basedpyright` |
| `ruff` for Python | works, but lint/format only — no type checking; prefer a type server |
| clangd without `--clang-tidy` | redefine `clangd` with your own `command` + `extensions` |

## Troubleshooting

- **"Could not find tsserver"**: `typescript-language-server` is only a wrapper — the `typescript` package must also be present, globally or in the project's `node_modules`.
- **Installed but still not found**: `npm i -g` writes to a bin dir new shells may not have yet — reopen the shell, re-check `which`.
- **Python wrong interpreter / missing imports**: the server must see the project venv — activate it, or point `pyrightconfig.json` (`venvPath`, `pythonPath`) at it.
- **rust-analyzer exits while loading rust-src**: `rustup component remove rust-src && rustup component add rust-src`.
- **Server runs but tools fail**: capture the exact error text and report it — do not reinstall blindly.

## Rules

- Never install anything globally without explicit user approval.
- One language per pass; verify before moving on.
- If a server is installed but tools still fail, report the exact error text — do not reinstall blindly.
