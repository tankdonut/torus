import assert from "node:assert/strict";
import { test } from "node:test";
import { setSharedState, sharedState } from "../extensions/shared-state.js";

const KEY = Symbol.for("torus.test.shared-state");
const OTHER = Symbol.for("torus.test.shared-state.other");

test("sharedState runs init exactly once across repeat reads", () => {
	try {
		let inits = 0;
		const first = sharedState(KEY, () => {
			inits += 1;
			return { n: 1 };
		});
		const second = sharedState(KEY, () => {
			inits += 1;
			return { n: 2 };
		});
		assert.equal(inits, 1);
		assert.equal(first, second);
		assert.equal(first.n, 1);
	} finally {
		delete globalThis[KEY];
	}
});

test("setSharedState overwrites the slot; sharedState reads it back", () => {
	try {
		sharedState(KEY, () => ({ n: 1 }));
		setSharedState(KEY, { n: 9 });
		assert.equal(sharedState(KEY, () => ({ n: 2 })).n, 9);
	} finally {
		delete globalThis[KEY];
	}
});

test("distinct keys hold distinct slots", () => {
	try {
		sharedState(KEY, () => ({ n: 1 }));
		setSharedState(OTHER, { n: 2 });
		assert.equal(sharedState(KEY, () => ({ n: 0 })).n, 1);
		assert.equal(sharedState(OTHER, () => ({ n: 0 })).n, 2);
	} finally {
		delete globalThis[KEY];
		delete globalThis[OTHER];
	}
});
