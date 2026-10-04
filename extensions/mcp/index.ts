import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Connected-and-working count: a registered server counts only once its
 * tools are declared to the model (`mcp__<server>__<tool>` entries in the
 * active set), which happens when its connection is up.
 */
export function connectedServerCount(servers: string[], activeTools: string[]): number {
	let count = 0;
	for (const name of servers) {
		const prefix = `mcp__${name}__`;
		if (activeTools.some((tool) => tool.startsWith(prefix))) count += 1;
	}
	return count;
}

export function mcpStatusText(connected: number, registered: number): string | undefined {
	if (registered <= 0) return undefined;
	if (connected <= 0) return "MCP 0";
	return `MCP ${connected}`;
}

export function registerMcp(pi: ExtensionAPI): void {
	pi.registerMcpServer("context7", { url: "https://mcp.context7.com/mcp", exposure: "direct" });
	pi.registerMcpServer("grep_app", { url: "https://mcp.grep.app", exposure: "direct" });
	// the connected count is rendered by the ui statusline (torus key);
	// polling on session_start + turn_start lives there too
}

export default function mcpExtension(pi: ExtensionAPI): void {
	registerMcp(pi);
}
