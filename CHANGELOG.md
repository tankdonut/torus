# Changelog

## [0.9.0](https://github.com/tankdonut/torus/compare/v0.8.0...v0.9.0) (2026-10-09)


### Features

* export TORUS_STATE_DIR and abbreviate state paths in output ([868f78b](https://github.com/tankdonut/torus/commit/868f78b94f0da916ad85b79e14b35afc5e28f874))


### Bug Fixes

* **deps:** update dependency pi-web-access to ^0.38.0 ([#32](https://github.com/tankdonut/torus/issues/32)) ([659730d](https://github.com/tankdonut/torus/commit/659730d01a2e4ffde67af16620cf1a4f653e81fe))
* **teams:** scope team state to the project namespace ([5f1ebfa](https://github.com/tankdonut/torus/commit/5f1ebfa32aa576991241ce6a28fd8b58bf5f7065))

## [0.8.0](https://github.com/tankdonut/torus/compare/v0.7.0...v0.8.0) (2026-10-09)


### Features

* **acp:** speak the Agent Client Protocol in both directions ([94472e9](https://github.com/tankdonut/torus/commit/94472e9d5bed7505935c331c6826488b25237ab3))
* doctor reports legacy state layout residue ([76a8649](https://github.com/tankdonut/torus/commit/76a86499e0135274182733cc5dde230a054771e1))
* **models:** user-configurable chains and alternate providers via chains.json ([e022cd3](https://github.com/tankdonut/torus/commit/e022cd311ef8d23b0968a3d11b7b2d4c5d95d357))
* project-scoped delegation logs and dream scoping ([5a79fd8](https://github.com/tankdonut/torus/commit/5a79fd8e6abc512a76ffbfb4536e8bfb45030a1f))
* project-scoped goal store with orphan-only GC ([e8be887](https://github.com/tankdonut/torus/commit/e8be887e1e91ae2a45a1b0a6f0edd14a2ff7b86a))
* project-scoped monitor logs ([b613225](https://github.com/tankdonut/torus/commit/b61322522fb575d2cea9c5f6585927814a54fc0f))
* project-scoped persona state with orphan-only GC ([9199f06](https://github.com/tankdonut/torus/commit/9199f063283bad1f7ad4a6ec1b45694a6199aea4))
* project-scoped plans and work ledgers ([003c728](https://github.com/tankdonut/torus/commit/003c728a1b4f48bd010d96e68c4a64d0b6209f96))
* project-scoped reflect state with orphan-only GC ([34c491d](https://github.com/tankdonut/torus/commit/34c491d445154cddaa3a42e56a9de4ad35415cbb))
* project-scoped todo store with orphan-only GC ([5e436a9](https://github.com/tankdonut/torus/commit/5e436a9bc68b5cef4e93e63254586b668a5e0e9f))
* sandbox host approvals stored per project ([8780f8a](https://github.com/tankdonut/torus/commit/8780f8a7bbaccb13eeaee91d0ce9ae58cb43f399))
* **skills:** expand torus-lsp-setup with full server table and config semantics ([8ff77f4](https://github.com/tankdonut/torus/commit/8ff77f4a820a2c7edb02e0f29db310249c9f7ea6))
* **state:** pi-style project key and per-project state dir helpers ([e998a75](https://github.com/tankdonut/torus/commit/e998a7583e8c4b11c0d1f88087e4b062b8cb7158))
* teams carry a project field with scoped defaults ([1b4d471](https://github.com/tankdonut/torus/commit/1b4d4712af9b93dd63617436a583b4d95dade16b))
* worktrees keyed by canonical project identity ([6caa7fe](https://github.com/tankdonut/torus/commit/6caa7fee864a5fbef2ab8b761fee419e3f716a65))


### Bug Fixes

* **deps:** force @modelcontextprotocol/sdk to 1.31.0 (Dependabot alert [#2](https://github.com/tankdonut/torus/issues/2)) ([ad489a2](https://github.com/tankdonut/torus/commit/ad489a2f7db9432f4071fc23f736a72418abb388))
* **payload:** pin payload installs to the baked repo lockfile ([e8f4bec](https://github.com/tankdonut/torus/commit/e8f4becd93db370d4196d6a99f2f06d0028aaba4))

## [0.7.0](https://github.com/tankdonut/torus/compare/v0.6.0...v0.7.0) (2026-10-09)


### Features

* **deps:** Update dependency @earendil-works/pi-ai to v1.1.0 ([ad478ac](https://github.com/tankdonut/torus/commit/ad478acbf80e77b903b6835e0b9eab2b46053ed6))
* **deps:** Update dependency @earendil-works/pi-coding-agent to v1.1.0 ([48bfbdb](https://github.com/tankdonut/torus/commit/48bfbdb8f076233c37e7802cd4515bc3174c6a90))
* **deps:** Update dependency @earendil-works/pi-tui to v1.1.0 ([246af60](https://github.com/tankdonut/torus/commit/246af60d04cfda078b912b4c5d9c3968d8ec3b37))
* rebuild overhead bench with robust stats, interleaving, and HTML report ([b7d6224](https://github.com/tankdonut/torus/commit/b7d622460276ee2fa3d1e6b61f0ef6c305dd02f4))


### Bug Fixes

* **deps:** raise node engines floor to 22.12 for sandbox-runtime 0.0.79 ([a6d7c5c](https://github.com/tankdonut/torus/commit/a6d7c5cab7bd92b84a9cb7185e524772e667a429))
* **deps:** update dependency @anthropic-ai/sandbox-runtime to v0.0.79 ([6d881d2](https://github.com/tankdonut/torus/commit/6d881d2549004fca19ae1c99d8425f6bcd90aa6d))
* **fleet:** show plain idle marker instead of banked work seconds ([9258133](https://github.com/tankdonut/torus/commit/92581334f715622d2e0f26377f75bfca44b57e27))
* **team:** normalize tasklist statuses so hand edits can't deadlock dependents ([903cbfc](https://github.com/tankdonut/torus/commit/903cbfcde143aba500ef60261569efdf97867217))
* **team:** resolve member model shorthands before records are written ([9352f5d](https://github.com/tankdonut/torus/commit/9352f5d027e57eb4ee32391b71885b1ba2ace7ea))

## [0.6.0](https://github.com/tankdonut/torus/compare/v0.5.0...v0.6.0) (2026-10-07)


### Features

* add scheduled triggers to torus serve ([6d419d9](https://github.com/tankdonut/torus/commit/6d419d9206678cb38a5e88921db19923e2462662))
* add torus serve with authenticated delegation API ([9e957aa](https://github.com/tankdonut/torus/commit/9e957aa171e05b5373976cab473da41136a6f8dd))
* add webhook triggers to torus serve ([8391c5a](https://github.com/tankdonut/torus/commit/8391c5ab513f06213cff19cec9886dc6f3062012))
* surface model errors from delegated runs ([2c04917](https://github.com/tankdonut/torus/commit/2c0491711c6d0daf1b95776b6e82b909526e1543))


### Bug Fixes

* restrict triggers-state file permissions ([7d4d711](https://github.com/tankdonut/torus/commit/7d4d7117322954e92c779e559706666b8c57a711))

## [0.5.0](https://github.com/tankdonut/torus/compare/v0.4.0...v0.5.0) (2026-10-07)


### Features

* add converge rows and the lens-review skill ([45b8118](https://github.com/tankdonut/torus/commit/45b8118cb271e001a66972214f5db7fa19745cdd))
* add opt-in member task self-claim ([12375bc](https://github.com/tankdonut/torus/commit/12375bcf36d0a6ec148f4d27c5580acb3dbde33b))
* block task claims on unmet dependencies ([9869b4d](https://github.com/tankdonut/torus/commit/9869b4d476b650c5726c5880533fb538273d63f6))
* emit structured results from core tools ([f2b7e33](https://github.com/tankdonut/torus/commit/f2b7e332749f72d430542496c934bb81966a6407))
* mirror work-ledger rows into session entries ([55f1635](https://github.com/tankdonut/torus/commit/55f1635e4054b8f33b71fdf6a244c82eb2d929a4))
* require plan approval before work binding ([ff347b4](https://github.com/tankdonut/torus/commit/ff347b4caee106e47c887ff59c59c615c3256f3a))
* surface stale in-progress team tasks ([f310cc2](https://github.com/tankdonut/torus/commit/f310cc236581b960df8eb56ec173a296100c4ef2))


### Bug Fixes

* refuse tasklist writes on missing teams instead of hanging ([82c9af0](https://github.com/tankdonut/torus/commit/82c9af0bc1fbdc5232f81d329ea7f9d10c0acf0f))

## [0.4.0](https://github.com/tankdonut/torus/compare/v0.3.0...v0.4.0) (2026-10-07)


### Features

* accept per-run model overrides in delegations ([a27652c](https://github.com/tankdonut/torus/commit/a27652cab8321220e4ef4ea78d69a8e5e4b7ffa8))
* add torus-vs-stock-pi overhead bench ([a3558ea](https://github.com/tankdonut/torus/commit/a3558ea323fa132c879adae2455c4266043a9dbd))
* colorize and click-route the fleet detail back chip ([98a8540](https://github.com/tankdonut/torus/commit/98a854044d965dfa5859d752fbd0bcdac16c460d))
* scope child agents with complete tool whitelists ([fef45a6](https://github.com/tankdonut/torus/commit/fef45a6e02b5d26fd15f9b909cd9be431cc2f786))
* scope MCP tools to researcher agents ([e8a465f](https://github.com/tankdonut/torus/commit/e8a465f30560dee1cba7f705f505700fd3f99d94))
* show engine-computed cost on delegation surfaces ([29ca42a](https://github.com/tankdonut/torus/commit/29ca42ad4ab18a940a2acbafc020bab6b1bfabec))
* show session cost in the statusline ([b602531](https://github.com/tankdonut/torus/commit/b6025310ab1b7cec1f90736d4734f8a76c0bb2b1))


### Bug Fixes

* alt+t fleet list scrolling, arrow keys, and run durations ([6761e96](https://github.com/tankdonut/torus/commit/6761e96df1c3102a04b94a0d122b3db3031ab30f))
* carry cost through live delegation snapshots ([7d316f2](https://github.com/tankdonut/torus/commit/7d316f2237013d1659d3bc8fa08a4b86144f145d))

## [0.3.0](https://github.com/tankdonut/torus/compare/v0.2.0...v0.3.0) (2026-10-07)


### Features

* enforce injection-defense clauses in agent prompts ([53526da](https://github.com/tankdonut/torus/commit/53526da4a46ce7e66f1ad64ab26ac4abf224e6d5))
* render research reports to themed standalone HTML ([1831834](https://github.com/tankdonut/torus/commit/1831834f46d63d80807bf37b01f3c549626563c5))
* style research reports as a print-ready dossier ([bad5583](https://github.com/tankdonut/torus/commit/bad5583fe33259a447b5f21254ee7bec5ba483bd))
* surface orphaned team tasks in team_status ([edb7211](https://github.com/tankdonut/torus/commit/edb7211463b5b177a32384bd5af3fbfec4d71577))


### Bug Fixes

* block symlinked paths in file guards ([da7af23](https://github.com/tankdonut/torus/commit/da7af23a8e5d09042afbb5fa2327e73c81928969))
* coalesce team wake-ups and quote the newest outbox tail ([f395c77](https://github.com/tankdonut/torus/commit/f395c770c12eeb0a715d295bed047fd7417d7f04))
* count every assistant turn in delegation tallies ([059a5c4](https://github.com/tankdonut/torus/commit/059a5c49956a1c3568ac3c958d2caec5f1544eda))
* flag custom tool failures with isError so refusals paint red ([bf2ac39](https://github.com/tankdonut/torus/commit/bf2ac39f758c172306357242ee08791b511144de))
* guard keywords.json against agent writes ([b63c8ca](https://github.com/tankdonut/torus/commit/b63c8cac9c56e8e761e09f01efda38f9171f0525))
* keep tables inside the report content column ([57570e2](https://github.com/tankdonut/torus/commit/57570e214f4cdbe1f956c9b11614ca4e68a5ef82))
* render edit success diffs in replayed fleet transcripts ([8a02ce4](https://github.com/tankdonut/torus/commit/8a02ce40f598c4b17b4097872b519e9c65c31849))
* show input tokens in fleet member lines ([8529b1c](https://github.com/tankdonut/torus/commit/8529b1c0beddab70283a051222e735d9091fae4c))
* widen report column to a fixed measure with larger body text ([532b459](https://github.com/tankdonut/torus/commit/532b459c38abf88018d8731d6642be1c86cd8949))
* widen report text measure and narrow the table breakout ([1315342](https://github.com/tankdonut/torus/commit/131534213fc1b7ab9e547d62c8e277a143e4ba81))

## [0.2.0](https://github.com/tankdonut/torus/compare/v0.1.0...v0.2.0) (2026-10-06)


### Features

* **deps:** Update dependency @earendil-works/pi-ai to v1.0.4 ([#9](https://github.com/tankdonut/torus/issues/9)) ([268baf9](https://github.com/tankdonut/torus/commit/268baf966abe13acc2239214e75173ebcc691864))
* **deps:** Update dependency @earendil-works/pi-coding-agent to v1.0.4 ([#10](https://github.com/tankdonut/torus/issues/10)) ([17857d3](https://github.com/tankdonut/torus/commit/17857d3384edb9de989678c306ed7c3ec64f68a7))
* **deps:** Update dependency @earendil-works/pi-tui to v1.0.4 ([#11](https://github.com/tankdonut/torus/issues/11)) ([8a8d16e](https://github.com/tankdonut/torus/commit/8a8d16efc75772e0f7951587b670e576be8aea7e))


### Bug Fixes

* **deps:** update dependency pi-web-access to ^0.37.0 ([#13](https://github.com/tankdonut/torus/issues/13)) ([71b18f9](https://github.com/tankdonut/torus/commit/71b18f96a7ca9b9e62492c82e96dd7921fdb9ce7))

## 0.1.0 (2026-10-05)


### Features

* add make.sh image/image-test targets sourcing .tool-versions pins ([8255cdb](https://github.com/tankdonut/torus/commit/8255cdbc0e554bc8923d1f8ba329a6d981ee809f))
* add multi-stage Dockerfile with pinned toolchain and full runtime deps ([e53312b](https://github.com/tankdonut/torus/commit/e53312bde9b117c7010a7fa89f3f2aec6dc3c1d3))
* add work extension for plan-execution state and deepen torus-plan/torus-execute skills ([6cbaa49](https://github.com/tankdonut/torus/commit/6cbaa4923a841a0ff4e1fc8657c68f4529693690))
* bake payload npm deps into the container image ([fe86a7e](https://github.com/tankdonut/torus/commit/fe86a7ea96eb6abaadf2284ab556cfb757791c72))
* dedupe dream/reflect entries against the store on apply ([6adf99f](https://github.com/tankdonut/torus/commit/6adf99f8579ab6e22fa426d212ad7bca7d0763b2))
* dual-trigger idle reflection — turn threshold, re-arm, per-session state ([4e9310c](https://github.com/tankdonut/torus/commit/4e9310c69a4de3865bb3bdf57bf2650e9ef3e306))
* feed the session transcript to idle reflection as primary activity ([f212085](https://github.com/tankdonut/torus/commit/f21208551ee9a0b53d7ceff857a6f8d5fa84e7ef))
* move fleet detail steer/stop into the footer status line ([1a9c9a4](https://github.com/tankdonut/torus/commit/1a9c9a4514ffeb8bd6763b60994d8c84af924a7c))
* per-session reflect-state layer (round-trip, GC, legacy unlink) ([b6d973e](https://github.com/tankdonut/torus/commit/b6d973ebe08d75b024b853b081c499628a00e6df))
* pin node/bun toolchain via .tool-versions and wire CI to it ([a94cc8a](https://github.com/tankdonut/torus/commit/a94cc8acfdf502264b37281839a7898e6ba96897))
* report torus version in /doctor ([4174abc](https://github.com/tankdonut/torus/commit/4174abc551cf4c4bf9f9c63b223da21269822745))
* stamp torus version into payload and launcher --version ([68698ef](https://github.com/tankdonut/torus/commit/68698ef7290510ef46e70ad7fcb1b21a007c0775))
* wake the model when a torus monitor fires and style its marker ([24b5e92](https://github.com/tankdonut/torus/commit/24b5e92702c27e1734590b01c083b27446a4a0c3))


### Bug Fixes

* delegate tool block — real turn counts, no start marker, click-to-fleet ([701a222](https://github.com/tankdonut/torus/commit/701a2222f00cba76df4fa1e130223ac2698c2d50))
* drop bwrap sandbox smoke — sandboxing unsupported in-container ([06ffcd0](https://github.com/tankdonut/torus/commit/06ffcd0dd52df56a8d8f982de16c12320424d58e))
* drop doubled blank-line separators in fleet transcript view ([51e77c3](https://github.com/tankdonut/torus/commit/51e77c335e3aac066d8ededf2f5715c631610c53))
* keep one blank row between fleet detail transcript and footer rule ([2d0e403](https://github.com/tankdonut/torus/commit/2d0e4033653a5245b4dcc252bb51e609642a5700))
* neutral start markers for background memory runs ([b4a284e](https://github.com/tankdonut/torus/commit/b4a284e6d267fb619e841df90965eb8ae37dbda8))
* quiet team wake-ups — skip "ready" handshakes, wake via triggerTurn marker ([c77778d](https://github.com/tankdonut/torus/commit/c77778d1d2d8bd3b63edeedf21a71bf4ce961112))
* resolve work slugs by prefix or substring, listing candidates in errors ([2b9acc7](https://github.com/tankdonut/torus/commit/2b9acc733b5eab4e60f4677e23c091824697b2a3))
* scope idle reflection to the invoking session's own delegation logs ([94fde71](https://github.com/tankdonut/torus/commit/94fde715d462b24b84f218ab8c52c6f5ba84ace7))
* send bare handle in fan-out result markers so the transcript line doesn't double the @ ([0f3d5d2](https://github.com/tankdonut/torus/commit/0f3d5d2e1c721bf69ad73d542052fcc1ea91b799))
* treat restricted-userns hosts as warned skip in bwrap smoke ([87f916d](https://github.com/tankdonut/torus/commit/87f916d741d331ba231d088183a8e623ec30981b))


### Miscellaneous Chores

* begin release cycle ([83c9b0d](https://github.com/tankdonut/torus/commit/83c9b0d5a8e985dbc26877b888dde313b437f55b))
* re-cut release 0.1.0 ([e1820a0](https://github.com/tankdonut/torus/commit/e1820a08a5e6140179f2251c6870760d453e8417))
