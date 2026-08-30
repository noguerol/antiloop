// antiloop — command handlers. Lazy-loaded on /antiloop.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "./config.ts";
import type { AntiloopState, Runtime } from "./types.ts";
import { formatDuration, selectFrom } from "./ui.ts";

export async function handleCommand(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	rt: Runtime,
): Promise<void> {
	const sub = (args ?? "").trim().toLowerCase();
	switch (sub) {
		case "enable":
			rt.config.enabled = true;
			saveConfig(rt.config);
			ctx.ui.notify("antiloop: ON", "info");
			rt.updateStatus(ctx);
			return;
		case "disable":
			rt.config.enabled = false;
			saveConfig(rt.config);
			ctx.ui.notify("antiloop: OFF", "info");
			rt.updateStatus(ctx);
			return;
		case "status":
			return showStatus(ctx, rt);
		case "config":
			return showConfigMenu(ctx, rt);
		case "log":
			return showLog(ctx, rt);
		case "reset":
			resetState(rt.state);
			rt.pendingIntervention = null;
			ctx.ui.notify("antiloop: reset", "info");
			rt.updateStatus(ctx);
			return;
		case "test":
			return runSelfTest(ctx);
		default:
			rt.config.enabled = !rt.config.enabled;
			saveConfig(rt.config);
			ctx.ui.notify(`antiloop: ${rt.config.enabled ? "ON" : "OFF"}`, "info");
			rt.updateStatus(ctx);
			return;
	}
}

async function showStatus(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	const lvl = ["none", "warn", "force", "abort"][rt.state.currentLevel];
	const recent = rt.state.detections.slice(-5);
	const lines = [
		`state: ${rt.config.enabled ? "ON" : "OFF"} · level: ${lvl} · consecutive: ${rt.state.consecutiveDetections}`,
		`total: ${rt.state.totalDetections} · tracked: ${rt.state.recentMessages.length} · forced: ${rt.state.inForcedBreak ? "yes" : "no"}`,
		"",
		"thresholds:",
		`  warn: ${rt.config.warningThreshold}  force: ${rt.config.forceBreakThreshold}  abort: ${rt.config.abortThreshold || "off"}`,
		`  similarity: ${(rt.config.similarityThreshold * 100).toFixed(0)}%  window: ${rt.config.detectionWindow}`,
		`  tool sim: ${(rt.config.toolSimilarityThreshold * 100).toFixed(0)}%  tool repeat: ${rt.config.minToolRepeatCount}+ prior`,
		`  result sim: ${(rt.config.resultSimilarityThreshold * 100).toFixed(0)}%  (same cmd + diff outcome = no loop)`,
		"",
		`detectors: text ${yn(rt.config.detectTextLoops)} · tool ${yn(rt.config.detectToolLoops)} · think ${yn(rt.config.detectThinkingLoops)}`,
	];
	if (recent.length) {
		lines.push("", "recent:");
		for (const d of recent) lines.push(`  [${d.type}] ${d.description} · ${formatDuration(Date.now() - d.timestamp)} ago`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function showConfigMenu(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	const c = rt.config;
	const picked = await selectFrom(ctx, "antiloop config", [
		{ value: "toggle" as const, label: c.enabled ? "🟢 disable" : "🔴 enable", description: "toggle detection" },
		{ value: "warn" as const, label: `warn threshold: ${c.warningThreshold}` },
		{ value: "force" as const, label: `force threshold: ${c.forceBreakThreshold}` },
		{ value: "abort" as const, label: `abort threshold: ${c.abortThreshold || "off"}`, description: "0 = disabled" },
		{ value: "sim" as const, label: `similarity: ${(c.similarityThreshold * 100).toFixed(0)}%` },
		{ value: "toolSim" as const, label: `tool similarity: ${(c.toolSimilarityThreshold * 100).toFixed(0)}%`, description: "args must match this closely to count as the same call" },
		{ value: "toolRepeat" as const, label: `tool repeat: ${c.minToolRepeatCount}+ prior`, description: "recurrences before a tool loop flags" },
		{ value: "resultSim" as const, label: `result similarity: ${(c.resultSimilarityThreshold * 100).toFixed(0)}%`, description: "same cmd + different outcome vetoes the loop" },
		{ value: "window" as const, label: `window: ${c.detectionWindow} msgs` },
		{ value: "text" as const, label: `text detect: ${yn(c.detectTextLoops)}` },
		{ value: "tool" as const, label: `tool detect: ${yn(c.detectToolLoops)}` },
		{ value: "think" as const, label: `think detect: ${yn(c.detectThinkingLoops)}` },
		{ value: "notify" as const, label: `notify: ${yn(c.notifyOnDetection)}` },
		{ value: "reset" as const, label: "reset state" },
	]);
	if (!picked) return;
	switch (picked) {
		case "toggle":
			c.enabled = !c.enabled;
			saveConfig(c);
			ctx.ui.notify(`antiloop: ${c.enabled ? "ON" : "OFF"}`, "info");
			rt.updateStatus(ctx);
			break;
		case "warn": {
			const v = await selectFrom(ctx, "warn threshold", [
				{ value: 1, label: "1 (sensitive)" },
				{ value: 2, label: "2 (default)" },
				{ value: 3, label: "3" },
				{ value: 5, label: "5 (relaxed)" },
			]);
			if (v !== undefined) { c.warningThreshold = v; saveConfig(c); ctx.ui.notify(`warn: ${v}`, "info"); }
			break;
		}
		case "force": {
			const v = await selectFrom(ctx, "force threshold", [
				{ value: 2, label: "2 (sensitive)" },
				{ value: 3, label: "3 (default)" },
				{ value: 5, label: "5" },
				{ value: 8, label: "8 (relaxed)" },
			]);
			if (v !== undefined) { c.forceBreakThreshold = v; saveConfig(c); ctx.ui.notify(`force: ${v}`, "info"); }
			break;
		}
		case "abort": {
			const v = await selectFrom(ctx, "abort threshold (0=off)", [
				{ value: 0, label: "off" },
				{ value: 5, label: "5" },
				{ value: 8, label: "8" },
				{ value: 10, label: "10" },
				{ value: 15, label: "15" },
			]);
			if (v !== undefined) { c.abortThreshold = v; saveConfig(c); ctx.ui.notify(`abort: ${v || "off"}`, "info"); }
			break;
		}
		case "sim": {
			const v = await selectFrom(ctx, "similarity", [
				{ value: 0.5, label: "50% (sensitive)" },
				{ value: 0.6, label: "60%" },
				{ value: 0.7, label: "70%" },
				{ value: 0.75, label: "75% (default)" },
				{ value: 0.8, label: "80%" },
				{ value: 0.9, label: "90% (relaxed)" },
			]);
			if (v !== undefined) { c.similarityThreshold = v; saveConfig(c); ctx.ui.notify(`similarity: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "toolSim": {
			const v = await selectFrom(ctx, "tool similarity (args)", [
				{ value: 0.99, label: "99% (strict)" },
				{ value: 0.95, label: "95% (default)" },
				{ value: 0.9, label: "90%" },
				{ value: 0.8, label: "80% (sensitive)" },
			]);
			if (v !== undefined) { c.toolSimilarityThreshold = v; saveConfig(c); ctx.ui.notify(`tool similarity: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "toolRepeat": {
			const v = await selectFrom(ctx, "tool repeat (prior occurrences)", [
				{ value: 1, label: "1 (sensitive)" },
				{ value: 2, label: "2 (default)" },
				{ value: 3, label: "3 (relaxed)" },
			]);
			if (v !== undefined) { c.minToolRepeatCount = v; saveConfig(c); ctx.ui.notify(`tool repeat: ${v}+ prior`, "info"); }
			break;
		}
		case "resultSim": {
			const v = await selectFrom(ctx, "result similarity (outcome veto)", [
				{ value: 0.95, label: "95% (strict — only near-identical results count as same outcome)" },
				{ value: 0.8, label: "80% (default)" },
				{ value: 0.6, label: "60% (relaxed — tolerates more output noise)" },
			]);
			if (v !== undefined) { c.resultSimilarityThreshold = v; saveConfig(c); ctx.ui.notify(`result similarity: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "window": {
			const v = await selectFrom(ctx, "window", [
				{ value: 5, label: "5" },
				{ value: 10, label: "10 (default)" },
				{ value: 15, label: "15" },
				{ value: 20, label: "20" },
			]);
			if (v !== undefined) { c.detectionWindow = v; saveConfig(c); ctx.ui.notify(`window: ${v}`, "info"); }
			break;
		}
		case "text":
			c.detectTextLoops = !c.detectTextLoops; saveConfig(c);
			ctx.ui.notify(`text: ${yn(c.detectTextLoops)}`, "info"); break;
		case "tool":
			c.detectToolLoops = !c.detectToolLoops; saveConfig(c);
			ctx.ui.notify(`tool: ${yn(c.detectToolLoops)}`, "info"); break;
		case "think":
			c.detectThinkingLoops = !c.detectThinkingLoops; saveConfig(c);
			ctx.ui.notify(`think: ${yn(c.detectThinkingLoops)}`, "info"); break;
		case "notify":
			c.notifyOnDetection = !c.notifyOnDetection; saveConfig(c);
			ctx.ui.notify(`notify: ${yn(c.notifyOnDetection)}`, "info"); break;
		case "reset":
			resetState(rt.state);
			rt.pendingIntervention = null;
			ctx.ui.notify("reset", "info");
			rt.updateStatus(ctx);
			break;
	}
}

async function showLog(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	if (!rt.state.detections.length) {
		ctx.ui.notify("no detections this session", "info");
		return;
	}
	const items = rt.state.detections.slice(-30).reverse().map((d) => ({
		value: "" as const,
		label: `[${d.type}] ${d.description}`,
		description: `${(d.similarity * 100).toFixed(0)}% · ${formatDuration(Date.now() - d.timestamp)} ago`,
	}));
	await selectFrom(ctx, `detections (${rt.state.detections.length} total)`, items);
}

export function resetState(state: AntiloopState): void {
	state.recentMessages = [];
	state.detections = [];
	state.currentLevel = 0;
	state.consecutiveDetections = 0;
	state.inForcedBreak = false;
	state.totalDetections = 0;
	state.lastDetectedTurnIndex = -1;
}

async function runSelfTest(ctx: ExtensionCommandContext): Promise<void> {
	const { runSelfTest } = await import("./detect.ts");
	ctx.ui.notify(`antiloop self-test\n${runSelfTest().join("\n")}`, "info");
}

function yn(b: boolean): string {
	return b ? "on" : "off";
}
