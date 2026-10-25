/**
 * torus — cc-safety-net load shim.
 *
 * The package extension wires through here so the session's permission
 * posture can gate it: in bypass mode (startup-only, TORUS_PERMISSION_MODE
 * set once at launch by the --permission-mode bypass flag) the safety net
 * never registers — its blocks, like every other guard, are off for that
 * session. Every other mode loads it unchanged.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ccsn from "../../node_modules/cc-safety-net/dist/pi/index.js";
import { isBypassMode } from "../automode/config.js";
import { gateExtension, type PlatformSupport } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

export default function ccSafetyNetExtension(pi: ExtensionAPI): void {
	if (!gateExtension("cc-safety-net", PLATFORM_SUPPORT)) return;
	if (isBypassMode()) return;
	ccsn(pi);
}
