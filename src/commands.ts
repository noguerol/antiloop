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
		`total: ${rt.state.totalDetections} · tracked: ${rt.state.recentMessages.length} · forced: ${rt.state.inForcedBreak ? "yes" : "no"} · steer: ${rt.state.steerDelivered ? `sent (${rt.state.ignoredSteerCount} ignored)` : "armed"}`,
		"",
		"thresholds:",
		`  warn: ${rt.config.warningThreshold}  force: ${rt.config.forceBreakThreshold}  abort: ${rt.config.abortThreshold || "off"}  stop-after-ignored-break: ${rt.config.ignoredSteerLimit}`,
		`  similarity: ${(rt.config.similarityThreshold * 100).toFixed(0)}%  window: ${rt.config.detectionWindow}`,
		`  tool sim: ${(rt.config.toolSimilarityThreshold * 100).toFixed(0)}%  tool repeat: ${rt.config.minToolRepeatCount}+ prior`,
		`  result sim: ${(rt.config.resultSimilarityThreshold * 100).toFixed(0)}%  (same cmd + diff outcome = no loop)`,
		`  degenerate: run ≥ ${rt.config.degenerateMaxRun} same word · freq ≥ ${rt.config.degenerateMaxFreq} @ ${(rt.config.degenerateMaxShare * 100).toFixed(0)}% (≥ ${rt.config.degenerateMinTokens} tokens) · weight ${rt.config.degenerateTurnWeight} · block bash ${yn(rt.config.blockDegenerateBash)}`,
		`  outcome: same failing result ≥ ${rt.config.outcomeMinRepeats} attempts (args ≥ ${(rt.config.outcomeArgSimilarity * 100).toFixed(0)}% sim, sig ≥ ${(rt.config.outcomeSigThreshold * 100).toFixed(0)}%)`,
		`  task streams: ${yn(rt.config.detectTaskStreams)} (min ${rt.config.taskStreamMinCalls} calls, twins ≥ ${(rt.config.taskStreamTwinThreshold * 100).toFixed(0)}%)`,
		"",
		`detectors: text ${yn(rt.config.detectTextLoops)} · tool ${yn(rt.config.detectToolLoops)} · think ${yn(rt.config.detectThinkingLoops)} · degenerate ${yn(rt.config.detectDegenerate)} · outcome ${yn(rt.config.detectOutcomeLoops)}`,
		`footer: interactive ${yn(rt.config.interactiveFooter)} · toggle: ${rt.config.toggleShortcut}`,
	];
	if (rt.state.activeTaskStreams.length) {
		lines.push("", `active batch: ${rt.state.activeTaskStreams.map((x) => `${x.tool}×${x.count}`).join(", ")}`);
	}
	if (recent.length) {
		lines.push("", "recent:");
		for (const d of recent) lines.push(`  [${d.type}] ${d.description} · ${formatDuration(Date.now() - d.timestamp)} ago`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function showConfigMenu(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	const c = rt.config;
	const picked = await selectFrom(ctx, "⚙️ antiloop config", [
		// ── 🎛️ General ──────────────────────────────────────────────
		{ value: "toggle" as const, label: c.enabled ? "🟢 disable" : "🔴 enable", description: "turn detection on or off" },
		{ value: "window" as const, label: `⏳ window: ${c.detectionWindow} msgs`, description: "how many recent messages are analyzed" },
		{ value: "notify" as const, label: `🔔 notifications: ${yn(c.notifyOnDetection)}`, description: "show a warning when a loop is detected" },
		{ value: "footer" as const, label: `📊 interactive footer: ${yn(c.interactiveFooter)}`, description: "experimental: replaces pi's footer and captures keystrokes (leave off if it misbehaves)" },
		{ value: "shortcut" as const, label: `⌨️ shortcut: ${c.toggleShortcut}`, description: "keys to toggle on/off without typing a command" },
		// ── 🎯 Detection ────────────────────────────────────────────
		{ value: "warn" as const, label: `⚠️ warn after: ${c.warningThreshold}`, description: "repetitions before antiloop warns you" },
		{ value: "force" as const, label: `🛑 force break after: ${c.forceBreakThreshold}`, description: "repetitions before forcing a change of approach" },
		{ value: "abort" as const, label: `🚨 abort after: ${c.abortThreshold || "off"}`, description: "repetitions before aborting (0 = disabled)" },
		{ value: "ignoredBreak" as const, label: `🛑 stop after ignored break: ${c.ignoredSteerLimit}`, description: "identical repeats allowed after the force break before antiloop stops the run" },
		{ value: "sim" as const, label: `📏 text similarity: ${(c.similarityThreshold * 100).toFixed(0)}%`, description: "how similar two messages must be to count as a loop" },
		{ value: "toolSim" as const, label: `🔧 call similarity: ${(c.toolSimilarityThreshold * 100).toFixed(0)}%`, description: "how identical tool calls must be to count as the same call" },
		{ value: "toolRepeat" as const, label: `🔁 call repeats: ${c.minToolRepeatCount}+`, description: "how many times the same call must repeat before it flags" },
		{ value: "resultSim" as const, label: `🧾 result similarity: ${(c.resultSimilarityThreshold * 100).toFixed(0)}%`, description: "same command + different result = progress, not a loop" },
		// ── 🌀 Degenerate (intra-message meltdown) ───────────────────────
		{ value: "degRun" as const, label: `🌀 degenerate run: ≥ ${c.degenerateMaxRun}`, description: "identical words in a row inside ONE message/call before it counts as stuck generation (noguerol ×5145 class)" },
		{ value: "degBlock" as const, label: `⛔ block degenerate bash: ${yn(c.blockDegenerateBash)}`, description: "stop a degenerate command before it executes (default on)" },
		// ── 📉 Outcome (no-progress) ────────────────────────────────
		{ value: "outcomeMin" as const, label: `📉 no-progress after: ${c.outcomeMinRepeats}`, description: "same failing outcome repeated this many times (mutated args ≥ 85% similar) before flagging — the NFS test-A…QQQ class" },
		// ── 📋 Task streams ─────────────────────────────────────────
		{ value: "streams" as const, label: `📋 task streams: ${yn(c.detectTaskStreams)}`, description: "batch work (punched_log / plan_manager / …) is not a loop" },
		{ value: "streamMin" as const, label: `📋 stream min calls: ${c.taskStreamMinCalls}`, description: "calls of the same tool before a batch is recognized" },
		{ value: "streamTwin" as const, label: `📋 twin threshold: ${(c.taskStreamTwinThreshold * 100).toFixed(0)}%`, description: "calls more similar than this = the same task repeated, not a batch" },
		// ── 🔍 Detectors ────────────────────────────────────────────
		{ value: "text" as const, label: `📝 text: ${yn(c.detectTextLoops)}`, description: "detect repeated text messages" },
		{ value: "tool" as const, label: `🔧 tools: ${yn(c.detectToolLoops)}`, description: "detect repeated tool calls" },
		{ value: "think" as const, label: `🧠 thinking: ${yn(c.detectThinkingLoops)}`, description: "detect repeated internal reasoning" },
		{ value: "deg" as const, label: `🌀 degenerate: ${yn(c.detectDegenerate)}`, description: "detect ONE message stuck repeating a single word/token (no repeated peer needed)" },
		{ value: "outcome" as const, label: `📉 outcome: ${yn(c.detectOutcomeLoops)}`, description: "detect many near-identical attempts all ending in the SAME failing outcome (no progress)" },
		// ── 🧹 ──────────────────────────────────────────────────────
		{ value: "reset" as const, label: "🧹 reset state", description: "clear counters and history" },
	]);
	if (!picked) return;
	switch (picked) {
		case "toggle":
			c.enabled = !c.enabled;
			saveConfig(c);
			ctx.ui.notify(`antiloop: ${c.enabled ? "ON" : "OFF"}`, "info");
			rt.updateStatus(ctx);
			break;
		case "window": {
			const v = await selectFrom(ctx, "⏳ window (messages to analyze)", [
				{ value: 5, label: "5" },
				{ value: 10, label: "🎯 10 (default)" },
				{ value: 15, label: "15" },
				{ value: 20, label: "20" },
			]);
			if (v !== undefined) { c.detectionWindow = v; saveConfig(c); ctx.ui.notify(`window: ${v}`, "info"); }
			break;
		}
		case "notify":
			c.notifyOnDetection = !c.notifyOnDetection; saveConfig(c);
			ctx.ui.notify(`notifications: ${yn(c.notifyOnDetection)}`, "info"); break;
		case "footer":
			c.interactiveFooter = !c.interactiveFooter; saveConfig(c);
			ctx.ui.notify(`interactive footer: ${yn(c.interactiveFooter)}`, "info");
			rt.refreshFooter?.(ctx);
			rt.updateStatus(ctx);
			break;
		case "shortcut": {
			const v = await selectFrom(ctx, "⌨️ toggle shortcut", [
				{ value: "esc+a" as const, label: "⌨️ esc+a (default)", description: "press ESC then a" },
				{ value: "off" as const, label: "🚫 off" },
			]);
			if (v !== undefined) { c.toggleShortcut = v; saveConfig(c); rt.refreshFooter?.(ctx); ctx.ui.notify(`shortcut: ${v}`, "info"); }
			break;
		}
		case "warn": {
			const v = await selectFrom(ctx, "⚠️ warn threshold", [
				{ value: 1, label: "⚡ 1 (sensitive)" },
				{ value: 2, label: "🎯 2 (default)" },
				{ value: 3, label: "3" },
				{ value: 5, label: "🐢 5 (relaxed)" },
			]);
			if (v !== undefined) { c.warningThreshold = v; saveConfig(c); ctx.ui.notify(`warn: ${v}`, "info"); }
			break;
		}
		case "force": {
			const v = await selectFrom(ctx, "🛑 force break threshold", [
				{ value: 2, label: "⚡ 2 (sensitive)" },
				{ value: 3, label: "🎯 3 (default)" },
				{ value: 5, label: "5" },
				{ value: 8, label: "🐢 8 (relaxed)" },
			]);
			if (v !== undefined) { c.forceBreakThreshold = v; saveConfig(c); ctx.ui.notify(`force break: ${v}`, "info"); }
			break;
		}
		case "abort": {
			const v = await selectFrom(ctx, "🚨 abort threshold (0 = disabled)", [
				{ value: 0, label: "🚫 off" },
				{ value: 5, label: "5" },
				{ value: 8, label: "8" },
				{ value: 10, label: "10" },
				{ value: 15, label: "15" },
			]);
			if (v !== undefined) { c.abortThreshold = v; saveConfig(c); ctx.ui.notify(`abort: ${v || "off"}`, "info"); }
			break;
		}
		case "sim": {
			const v = await selectFrom(ctx, "📏 text similarity", [
				{ value: 0.5, label: "⚡ 50% (sensitive)" },
				{ value: 0.6, label: "60%" },
				{ value: 0.7, label: "70%" },
				{ value: 0.75, label: "🎯 75% (default)" },
				{ value: 0.8, label: "80%" },
				{ value: 0.9, label: "🐢 90% (relaxed)" },
			]);
			if (v !== undefined) { c.similarityThreshold = v; saveConfig(c); ctx.ui.notify(`similarity: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "toolSim": {
			const v = await selectFrom(ctx, "🔧 call similarity (arguments)", [
				{ value: 0.99, label: "⚡ 99% (strict)" },
				{ value: 0.95, label: "🎯 95% (default)" },
				{ value: 0.9, label: "90%" },
				{ value: 0.8, label: "🐢 80% (sensitive)" },
			]);
			if (v !== undefined) { c.toolSimilarityThreshold = v; saveConfig(c); ctx.ui.notify(`call similarity: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "toolRepeat": {
			const v = await selectFrom(ctx, "🔁 call repeats", [
				{ value: 1, label: "⚡ 1 (sensitive)" },
				{ value: 2, label: "🎯 2 (default)" },
				{ value: 3, label: "🐢 3 (relaxed)" },
			]);
			if (v !== undefined) { c.minToolRepeatCount = v; saveConfig(c); ctx.ui.notify(`call repeats: ${v}+`, "info"); }
			break;
		}
		case "resultSim": {
			const v = await selectFrom(ctx, "🧾 result similarity (progress veto)", [
				{ value: 0.95, label: "⚡ 95% (strict — only near-identical results count as the same)" },
				{ value: 0.8, label: "🎯 80% (default)" },
				{ value: 0.6, label: "🐢 60% (relaxed — tolerates more output noise)" },
			]);
			if (v !== undefined) { c.resultSimilarityThreshold = v; saveConfig(c); ctx.ui.notify(`result similarity: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "degRun": {
			const v = await selectFrom(ctx, "🌀 degenerate run (identical words in a row inside one payload)", [
				{ value: 8, label: "⚡ 8 (sensitive)" },
				{ value: 16, label: "🎯 16 (default)" },
				{ value: 24, label: "24" },
				{ value: 48, label: "🐢 48 (relaxed)" },
			]);
			if (v !== undefined) { c.degenerateMaxRun = v; saveConfig(c); ctx.ui.notify(`degenerate run: ≥ ${v}`, "info"); }
			break;
		}
		case "degBlock":
			c.blockDegenerateBash = !c.blockDegenerateBash; saveConfig(c);
			ctx.ui.notify(`block degenerate bash: ${yn(c.blockDegenerateBash)}`, "info"); break;
		case "outcomeMin": {
			const v = await selectFrom(ctx, "📉 no-progress threshold (same failing outcome, near-identical args)", [
				{ value: 4, label: "⚡ 4 (sensitive — long experiment series get cut early)" },
				{ value: 6, label: "6" },
				{ value: 8, label: "🎯 8 (default)" },
				{ value: 12, label: "🐢 12 (relaxed)" },
			]);
			if (v !== undefined) { c.outcomeMinRepeats = v; saveConfig(c); ctx.ui.notify(`no-progress after: ${v}`, "info"); }
			break;
		}
		case "streams":
			c.detectTaskStreams = !c.detectTaskStreams; saveConfig(c);
			ctx.ui.notify(`task streams: ${yn(c.detectTaskStreams)}`, "info"); break;
		case "streamMin": {
			const v = await selectFrom(ctx, "📋 stream min calls", [
				{ value: 2, label: "⚡ 2 (sensitive)" },
				{ value: 3, label: "🎯 3 (default)" },
				{ value: 4, label: "4" },
				{ value: 5, label: "🐢 5 (conservative)" },
			]);
			if (v !== undefined) { c.taskStreamMinCalls = v; saveConfig(c); ctx.ui.notify(`stream min calls: ${v}`, "info"); }
			break;
		}
		case "streamTwin": {
			const v = await selectFrom(ctx, "📋 twin threshold (arguments)", [
				{ value: 0.99, label: "🎯 99% (default — any real difference = distinct task)" },
				{ value: 0.95, label: "95% (near-identical arguments count as the same task)" },
				{ value: 0.9, label: "⚡ 90% (more aggressive loop detection)" },
			]);
			if (v !== undefined) { c.taskStreamTwinThreshold = v; saveConfig(c); ctx.ui.notify(`twin threshold: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "ignoredBreak": {
			const v = await selectFrom(ctx, "🛑 stop after ignored break (identical repeats after the force break)", [
				{ value: 1, label: "⚡ 1 (sensitive — one identical repeat after the break stops the run)" },
				{ value: 2, label: "🎯 2 (default)" },
				{ value: 3, label: "🐢 3 (lenient)" },
			]);
			if (v !== undefined) { c.ignoredSteerLimit = v; saveConfig(c); ctx.ui.notify(`stop after ignored break: ${v}`, "info"); }
			break;
		}
		case "text":
			c.detectTextLoops = !c.detectTextLoops; saveConfig(c);
			ctx.ui.notify(`text: ${yn(c.detectTextLoops)}`, "info"); break;
		case "tool":
			c.detectToolLoops = !c.detectToolLoops; saveConfig(c);
			ctx.ui.notify(`tools: ${yn(c.detectToolLoops)}`, "info"); break;
		case "think":
			c.detectThinkingLoops = !c.detectThinkingLoops; saveConfig(c);
			ctx.ui.notify(`thinking: ${yn(c.detectThinkingLoops)}`, "info"); break;
		case "deg":
			c.detectDegenerate = !c.detectDegenerate; saveConfig(c);
			ctx.ui.notify(`degenerate: ${yn(c.detectDegenerate)}`, "info"); break;
		case "outcome":
			c.detectOutcomeLoops = !c.detectOutcomeLoops; saveConfig(c);
			ctx.ui.notify(`outcome: ${yn(c.detectOutcomeLoops)}`, "info"); break;
		case "reset":
			resetState(rt.state);
			ctx.ui.notify("🧹 state reset", "info");
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
	await selectFrom(ctx, `🕵️ detections (${rt.state.detections.length} total)`, items);
}

export function resetState(state: AntiloopState): void {
	state.recentMessages = [];
	state.detections = [];
	state.activeTaskStreams = [];
	state.currentLevel = 0;
	state.consecutiveDetections = 0;
	state.inForcedBreak = false;
	state.totalDetections = 0;
	state.lastDetectedTurnIndex = -1;
	state.steerDelivered = false;
	state.ignoredSteerCount = 0;
	state.turnSeq = 0;
}

async function runSelfTest(ctx: ExtensionCommandContext): Promise<void> {
	const { runSelfTest } = await import("./detect.ts");
	ctx.ui.notify(`antiloop self-test\n${runSelfTest().join("\n")}`, "info");
}

function yn(b: boolean): string {
	return b ? "on" : "off";
}
