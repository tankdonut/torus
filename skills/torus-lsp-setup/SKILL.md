---
name: torus-lsp-setup
description: "Diagnose and fix LSP tooling when lsp_* tools fail or a language is unsupported: map the file type to a language server, check PATH, install with permission, verify with lsp_diagnostics. Use when an lsp_ tool errors, returns nothing for a known language, or the user asks to set up LSP for a toolchain."
---

# torus-lsp-setup

The LSP tools come from pi-lsp-client. They work only when a language server for the file's language is installed and on PATH. This skill turns a dead LSP tool into a working one.

## Flow

1. **Identify the language** from the failing file's extension. Common map:

   | Extension | Server | Install |
   |---|---|---|
   | `.ts` `.tsx` `.js` `.jsx` | `typescript-language-server` (+ `typescript`) | `npm i -g typescript typescript-language-server` |
   | `.go` | `gopls` | `go install golang.org/x/tools/gopls@latest` |
   | `.py` | `pyright` | `pip install pyright` or `npm i -g pyright` |
   | `.rs` | `rust-analyzer` | `rustup component add rust-analyzer` |
   | `.c` `.cpp` | `clangd` | system package manager |
   | `.lua` | `lua-language-server` | system package manager |
   | `.zig` | `zls` | `zig env` instructions |

2. **Check**: `which <server>` via bash. Present → skip to step 4.
3. **Install — ask first.** Installing is a global machine change: state the exact command, get the user's go-ahead, run it via bash, re-check `which`.
4. **Verify**: run `lsp_diagnostics` on the original file. Empty or real diagnostics = working; a server error = keep diagnosing (check `<server> --version` runs, check the file is in a real project root).
5. **Non-standard servers or flags**: write a project `.pi/lsp-client.json` entry (takes priority over built-ins):

   ```json
   { "lsp": { "<name>": { "command": ["<server>", "--stdio"], "extensions": [".<ext>"], "priority": 100 } } }
   ```

   Then `/reload` or restart the session and re-verify.

## Rules

- Never install anything globally without explicit user approval.
- One language per pass; verify before moving on.
- If a server is installed but tools still fail, report the exact error text — do not reinstall blindly.
