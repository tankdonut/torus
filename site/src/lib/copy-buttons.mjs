// One delegated click handler for every [data-copy] button on a page: the
// landing's CodeBlock blocks and the markdown fences (rehype plugin in
// lib/code-copy.mjs) share it. Idempotent, so a page composing both sources
// still installs exactly one listener.

export function installCopyButtons() {
	const root = document.documentElement;
	if (root.dataset.copyButtons === "1") return;
	root.dataset.copyButtons = "1";
	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("button[data-copy]");
		if (!button) return;
		const text = button.dataset.copy ?? "";
		void navigator.clipboard?.writeText(text).then(() => {
			button.textContent = "copied";
			button.setAttribute("data-copied", "");
			setTimeout(() => {
				button.textContent = "copy";
				button.removeAttribute("data-copied");
			}, 1500);
		});
	});
}
