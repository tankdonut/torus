# Changelog

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
