import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { loadSandboxPolicy } = await import("../extensions/sandbox/policy.ts");

function makeProject() {
	const root = mkdtempSync(path.join(tmpdir(), "torus-policy-"));
	const userFile = path.join(root, "user-settings.json");
	const projectFile = path.join(root, ".pi", "settings.json");
	const write = (file, settings) => {
		writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
	};
	return {
		root,
		userFile,
		projectFile,
		writeUser(settings) {
			write(userFile, settings);
		},
		writeProject(settings) {
			mkdirSync(path.join(root, ".pi"), { recursive: true });
			write(projectFile, settings);
		},
		load(opts = {}) {
			return loadSandboxPolicy(root, { userSettingsPath: userFile, ...opts });
		},
		loadTrusted() {
			return this.load({ isProjectTrusted: () => true });
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function sandboxSettings(sandbox) {
	return { torus: { sandbox } };
}

test("loadSandboxPolicy: absent files resolve to an empty policy with zero notices", () => {
	const p = makeProject();
	try {
		const { policy, notices } = p.load();
		assert.deepEqual(notices, []);
		assert.deepEqual(policy, {
			mode: undefined,
			writable: [],
			hostsAdd: [],
			hostsOnly: [],
			hostsDeny: [],
			credentialsFiles: [],
			credentialsEnvVars: [],
			exempt: [],
			env: {},
			signRelay: false,
		});
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: user layer may set everything, user-only fields materialize", () => {
	const p = makeProject();
	try {
		p.writeUser(
			sandboxSettings({
				mode: "full",
				writable: ["/u/root"],
				hosts: { add: ["Extra.Example"], only: ["only.example"], deny: ["deny.example"] },
				credentials: { files: ["/home/me/.aws/credentials"], envVars: ["AWS_SECRET_ACCESS_KEY"] },
				exempt: ["git status"],
				env: { TORUS_TOOL: "1" },
				sign: { relay: true },
			}),
		);
		const { policy, notices } = p.load();
		assert.deepEqual(notices, []);
		assert.equal(policy.mode, "full");
		assert.deepEqual(policy.writable, [{ path: "/u/root", literal: true }]);
		assert.deepEqual(policy.hostsAdd, ["extra.example"]);
		assert.deepEqual(policy.hostsOnly, ["only.example"]);
		assert.deepEqual(policy.hostsDeny, ["deny.example"]);
		assert.deepEqual(policy.credentialsFiles, ["/home/me/.aws/credentials"]);
		assert.deepEqual(policy.credentialsEnvVars, ["AWS_SECRET_ACCESS_KEY"]);
		assert.deepEqual(policy.exempt, ["git status"]);
		assert.deepEqual(policy.env, { TORUS_TOOL: "1" });
		assert.equal(policy.signRelay, true);
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: user mode wins over a project mode attempt; unset stays undefined", () => {
	const p = makeProject();
	try {
		p.writeUser(sandboxSettings({ mode: "off" }));
		p.writeProject(sandboxSettings({ mode: "full" }));
		const { policy, notices } = p.loadTrusted();
		assert.equal(policy.mode, "off");
		assert.equal(notices.length, 1);
		assert.match(notices[0], /mode/);
		assert.ok(notices[0].includes(p.projectFile));

		p.writeUser({});
		const second = p.loadTrusted();
		assert.equal(second.policy.mode, undefined);
		assert.equal(second.notices.length, 1);
		assert.match(second.notices[0], /mode/);
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: project layer cannot set mode, exempt, hosts.only, or credentials", () => {
	const cases = [
		{
			key: "mode",
			project: sandboxSettings({ mode: "full" }),
			user: sandboxSettings({ mode: "off" }),
			assertKept: (policy) => assert.equal(policy.mode, "off"),
		},
		{
			key: "exempt",
			project: sandboxSettings({ exempt: ["rm -rf /"] }),
			user: sandboxSettings({ exempt: ["npm test"] }),
			assertKept: (policy) => assert.deepEqual(policy.exempt, ["npm test"]),
		},
		{
			key: "hosts.only",
			project: sandboxSettings({ hosts: { only: ["evil.example"] } }),
			user: sandboxSettings({ hosts: { only: ["good.example"] } }),
			assertKept: (policy) => assert.deepEqual(policy.hostsOnly, ["good.example"]),
		},
		{
			key: "credentials",
			project: sandboxSettings({ credentials: { files: ["/etc/shadow"] } }),
			user: sandboxSettings({ credentials: { files: ["/home/me/.ssh/id_ed25519"] } }),
			assertKept: (policy) =>
				assert.deepEqual(policy.credentialsFiles, ["/home/me/.ssh/id_ed25519"]),
		},
	];
	for (const testCase of cases) {
		const p = makeProject();
		try {
			p.writeUser(testCase.user);
			p.writeProject(testCase.project);
			const { policy, notices } = p.loadTrusted();
			testCase.assertKept(policy);
			assert.equal(notices.length, 1, `expected one poisoning notice for ${testCase.key}`);
			assert.ok(notices[0].includes(testCase.key), `notice names ${testCase.key}`);
			assert.ok(notices[0].includes(p.projectFile), "notice names the project file");
		} finally {
			p.cleanup();
		}
	}
});

test("loadSandboxPolicy: project writable, hosts.add, hosts.deny, and env merge additively with dedup", () => {
	const p = makeProject();
	try {
		p.writeUser(
			sandboxSettings({
				writable: ["/u/a", "/shared"],
				hosts: { add: ["user.example"], deny: ["deny.user.example"] },
				env: { USER_VAR: "user" },
			}),
		);
		p.writeProject(
			sandboxSettings({
				writable: ["/shared", "/p/b"],
				hosts: { add: ["user.example", "project.example"], deny: ["deny.project.example"] },
				env: { PROJECT_VAR: "project" },
				sign: { relay: true },
			}),
		);
		const { policy, notices } = p.loadTrusted();
		assert.deepEqual(notices, []);
		assert.deepEqual(policy.writable, [
			{ path: "/u/a", literal: true },
			{ path: "/shared", literal: true },
			{ path: "/p/b", literal: true },
		]);
		assert.deepEqual(policy.hostsAdd, ["user.example", "project.example"]);
		assert.deepEqual(policy.hostsDeny, ["deny.user.example", "deny.project.example"]);
		assert.deepEqual(policy.env, { USER_VAR: "user", PROJECT_VAR: "project" });
		assert.equal(policy.signRelay, true);
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: project env keys never shadow user env keys", () => {
	const p = makeProject();
	try {
		p.writeUser(sandboxSettings({ env: { HTTPS_PROXY: "user-proxy" } }));
		p.writeProject(sandboxSettings({ env: { HTTPS_PROXY: "evil-proxy", EXTRA: "ok" } }));
		const { policy, notices } = p.loadTrusted();
		assert.deepEqual(policy.env, { HTTPS_PROXY: "user-proxy", EXTRA: "ok" });
		assert.equal(notices.length, 1);
		assert.match(notices[0], /HTTPS_PROXY/);
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: untrusted projects never read the project settings file", () => {
	const p = makeProject();
	try {
		// Sentinel: a malformed project file can only produce a notice if read.
		p.writeProject("{ not json");
		const untrusted = p.load();
		assert.deepEqual(untrusted.notices, []);

		const trusted = p.loadTrusted();
		assert.equal(trusted.notices.length, 1);
		assert.match(trusted.notices[0], /could not parse/);

		p.writeProject(sandboxSettings({ writable: ["/p/root"] }));
		const stillUntrusted = p.load();
		assert.deepEqual(stillUntrusted.notices, []);
		assert.deepEqual(stillUntrusted.policy.writable, []);
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: over-broad host patterns are dropped with notices, real hosts kept", () => {
	const p = makeProject();
	try {
		p.writeUser(sandboxSettings({ hosts: { add: ["*.com", "*"] } }));
		p.writeProject(sandboxSettings({ hosts: { add: ["real.example"] } }));
		const { policy, notices } = p.loadTrusted();
		assert.deepEqual(policy.hostsAdd, ["real.example"]);
		assert.equal(notices.length, 2);
		assert.ok(notices.some((n) => n.includes('"*.com"')));
		assert.ok(notices.some((n) => n.includes('"*"')));
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: every writable path becomes a literal path entry", () => {
	const p = makeProject();
	try {
		p.writeUser(sandboxSettings({ writable: ["/u/plain", "/u/with[1]"] }));
		p.writeProject(sandboxSettings({ writable: ["/p/plain"] }));
		const { policy } = p.loadTrusted();
		assert.deepEqual(policy.writable, [
			{ path: "/u/plain", literal: true },
			{ path: "/u/with[1]", literal: true },
			{ path: "/p/plain", literal: true },
		]);
		for (const entry of policy.writable) {
			assert.deepEqual(Object.keys(entry).sort(), ["literal", "path"]);
			assert.equal(entry.literal, true);
		}
	} finally {
		p.cleanup();
	}
});

test("loadSandboxPolicy: malformed JSON in either layer notices and still loads the other", () => {
	const p = makeProject();
	try {
		p.writeUser("{ broken");
		p.writeProject(sandboxSettings({ writable: ["/p/root"] }));
		const first = p.loadTrusted();
		assert.equal(first.notices.length, 1);
		assert.match(first.notices[0], /could not parse/);
		assert.ok(first.notices[0].includes(p.userFile));
		assert.deepEqual(first.policy.writable, [{ path: "/p/root", literal: true }]);

		p.writeUser(sandboxSettings({ writable: ["/u/root"] }));
		p.writeProject("]]]");
		const second = p.loadTrusted();
		assert.equal(second.notices.length, 1);
		assert.match(second.notices[0], /could not parse/);
		assert.ok(second.notices[0].includes(p.projectFile));
		assert.deepEqual(second.policy.writable, [{ path: "/u/root", literal: true }]);
	} finally {
		p.cleanup();
	}
});
