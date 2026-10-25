/**
 * The cc-safety-net package ships no types for its pi entry
 * (dist/pi/index.js); declare the shape the shim consumes. The wildcard
 * prefix matches the relative specifier the shim imports by (any path
 * ending in cc-safety-net/dist/pi/index.js).
 */
declare module "*cc-safety-net/dist/pi/index.js" {
	const extension: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
	export default extension;
}
