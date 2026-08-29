// antiloop — UI helpers. Lazy-loaded with command handler.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

// Labeled select: returns the matched `value` from `items`, or undefined if cancelled.
export async function selectFrom<T>(
	ctx: ExtensionContext,
	title: string,
	items: Array<{ value: T; label: string; description?: string }>,
): Promise<T | undefined> {
	const strings = items.map((it) => (it.description ? `${it.label} — ${it.description}` : it.label));
	const picked = await ctx.ui.select(title, strings);
	if (picked === undefined) return undefined;
	const idx = strings.indexOf(picked);
	return idx >= 0 ? items[idx].value : undefined;
}
