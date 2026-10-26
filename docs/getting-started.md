# Getting started

torus installs four ways: pi package, single binary, container image, or source checkout. This page covers the install paths, the first five minutes of a session, and the permission modes with the automode rules. Each section links to its reference page for the full surface.

## Install

**As a pi package**: you need [pi](https://github.com/earendil-works/pi) installed first; its README covers installation. Then one command loads the full extension pack, skills, and agent roster, with no clone and no build:

```sh
pi install git:github.com/tankdonut/torus@vX.Y.Z
```

Launcher-only surfaces (`torus serve`, `torus acp-agent`) are not part of this mode; see [pi-packages.md](pi-packages.md).

**As a single binary**: download `torus-<os>-<arch>` from [releases](https://github.com/tankdonut/torus/releases), make it executable, and run it. The first launch self-bootstraps the runtime:

```sh
chmod +x torus-<os>-<arch> && ./torus-<os>-<arch>
```

**In a container** (full toolchain, no host install):

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

**From source** (contributor path). Platform support is declared per extension, so on other platforms unsupported extensions skip loading with a notice instead of failing later; see [extensions.md](extensions.md). tmux is optional, since delegation panes only appear inside tmux. The Node version floor is declared in [`package.json`](../package.json):

```sh
git clone https://github.com/tankdonut/torus.git && cd torus
./make.sh npmrc      # one-time: writes .npmrc (agents are blocked from writing it by design)
npm install
./runtime/bin/torus.mjs
```

All paths need provider auth on first run: `/login zai` signs in to the built-in Z.ai provider (GLM models). In containers, mount credentials read-only instead; see [container.md](container.md).

## First five minutes

Meet the roster, delegate something small, and try a keyword gate:

1. `/roster`: the agents, their model chains, and credentialed providers.
2. Delegate something small: `/explorer where does the roster load from?`
3. Say `team` in a message (or `deepwork`, `blueprint`). Keyword gates switch the session's execution mode.
4. `/goal` to pin a standing objective; `/reflect` to distill the session into memory.

Every delegation opens a tmux pane on the right, tailing what the agent does live. The statusline gains an entry per running child, and **alt+t** opens the fleet browser over every agent, where `s` steers one mid-run and `x` stops it. The agents, their model chains, and the delegation tools are documented in the [roster section](extensions.md#roster) of extensions.md.

## Permission modes

torus starts in default mode: guards, sandboxing, and approval prompts judge tool calls as they run. Automode is an opt-in permission layer for unattended work: a decision model classifies each bash command, approves the safe ones, and asks before anything risky. Turn it on with `torus --permission-mode auto` or `TORUS_PERMISSION_MODE=auto`, or default it on with `"permissionMode": "auto"` in `~/.torus/config.json`; `1` and `on` also select auto mode, while unset, `0`, `off`, and `default` keep the built-in gate. The config key sets the default, the env var overrides it, and the flag sets the env var for one session. `/automode` reports the live status (naming where the mode came from) and switches the current session.

Bypass mode turns every permission guard off at once: `torus --permission-mode bypass` (or `TORUS_PERMISSION_MODE=bypass`) starts the session with the context guards, cc-safety-net, the sandbox, the approval dialog, and the automode classifier all disabled, and the statusline carries a red `bypass` chip while it runs. Bypass is startup-only: it cannot be set from config.json (a `"bypass"` value there is refused with a warning) or switched mid-session, so each bypass session is a deliberate launch.

Your rules run first, from the `automode` section of the unified config file `~/.torus/config.json` (see [configuration.md](configuration.md#the-unified-config-file)):

```json
{
  "deny": ["git push --force *", "npm publish *"],
  "ask": ["git push *", "npx *"],
  "allow": ["npm test *", "node --test *"],
  "environment": [
    "Source control: github.com/tankdonut and all repos under it",
    "Package registry: the default npm registry is fine"
  ],
  "softDeny": ["leave the staging database untouched"],
  "softDenyExceptions": ["pg_dump against staging for a nightly backup"],
  "hardDeny": ["never read or send ~/.ssh credentials anywhere"],
  "classifyAllShell": false
}
```

Entries are prefix patterns evaluated in deny, ask, then allow order; broad allow entries such as `*` match nothing and draw a warning at load. A fixed critical-operation floor covers `sudo` and `su`, recursive forced `rm` on root or home paths, force pushes, and recursive `chmod` or `chown` on root paths, and floored commands never take an allow-rule shortcut; `classifyAllShell` suspends allow rules while auto mode is on. The `environment`, `softDeny`, `softDenyExceptions`, and `hardDeny` entries are prose for the judge: a softDeny entry denies unless a matching `softDenyExceptions` entry or a recent, specific user intent line clears it. Read-only commands pass without a model call, three consecutive decision-model denies switch the session to asking for everything, and when every model path fails the command still runs unjudged with an `[automode]` notice in its tool result. Automode only adds gates: denials from guards, `cc-safety-net`, sandbox, and approval still win, and every decision appends one JSON line to `automode.log`.

`/automode denied` lists the last denials from the audit log, and `/automode setup` drafts `environment` entries from the repo's git remotes and `ask` entries from repeated audit denials. The full pipeline order, judge tiers, classifier pinning, and fallback chains are in the [automode section](extensions.md#automode) of extensions.md.

## Where next

The reference pages, by surface:

- [configuration.md](configuration.md): every config section, knob, and env var
- [extensions.md](extensions.md): every tool, command, and env var
- [serve.md](serve.md): the authenticated HTTP server and the ACP agent
- [container.md](container.md): container usage and flags
- [pi-packages.md](pi-packages.md): the pi-package install model and what it omits
- [skills.md](skills.md): skill manifests, import, and export
