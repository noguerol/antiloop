/**
 * antiloop — detect reasoning loops and intervene.
 * Hooks: message_end, input, before_agent_start, context, turn_end, session_start.
 * Commands: /antiloop [enable|disable|status|config|log|reset|test]
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import type { AntiloopState, LoopDetection, Runtime } from "./types.ts";

const ICONS = ["", "⚠️", "🛑", "🚨"] as const;

function newState(): AntiloopState {
	return {
		recentMessages: [],
		detections: [],
		currentLevel: 0,
		consecutiveDetections: 0,
		inForcedBreak: false,
		totalDetections: 0,
		lastUserMessageTime: 0,
	};
}

export default function antiloopExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	let state = newState();

	function updateStatus(ctx: ExtensionContext): void {
		if (!config.enabled) ctx.ui.setStatus("antiloop", undefined);
		else if (state.currentLevel === 0) ctx.ui.setStatus("antiloop", "🔄 antiloop");
		else ctx.ui.setStatus("antiloop", `${ICONS[state.currentLevel]} antiloop(${state.consecutiveDetections})`);
	}

	const rt: Runtime = { config, state, pendingIntervention: null, updateStatus };
	const setPending = (v: string | null) => { rt.pendingIntervention = v; };

	function processDetections(
		detections: LoopDetection[],
		interventionMessage: (level: 1 | 2 | 3, d: LoopDetection[]) => string,
	): void {
		if (!detections.length) {
			if (state.consecutiveDetections > 0) state.consecutiveDetections = Math.max(0, state.consecutiveDetections - 1);
			if (state.currentLevel > 0 && state.consecutiveDetections === 0) {
				state.currentLevel = 0;
				state.inForcedBreak = false;
			}
			return;
		}
		state.consecutiveDetections++;
		state.totalDetections++;
		state.detections.push(...detections);
		if (state.detections.length > config.maxHistoryEntries) state.detections = state.detections.slice(-config.maxHistoryEntries);

		let next: 0 | 1 | 2 | 3 = 0;
		if (state.consecutiveDetections >= config.abortThreshold && config.abortThreshold > 0) next = 3;
		else if (state.consecutiveDetections >= config.forceBreakThreshold) next = 2;
		else if (state.consecutiveDetections >= config.warningThreshold) next = 1;
		if (next > state.currentLevel) state.currentLevel = next;

		if (state.currentLevel > 0) {
			setPending(interventionMessage(state.currentLevel as 1 | 2 | 3, detections));
			state.inForcedBreak = state.currentLevel >= 2;
		}
	}

	pi.on("message_end", async (event, ctx) => {
		if (!config.enabled) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;

		const { detectLoops, interventionMessage } = await import("./detect.ts");

		let content = "";
		let thinking = "";
		if (typeof msg.content === "string") content = msg.content;
		else if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (p.type === "text") content += p.text;
				else if (p.type === "thinking") thinking += p.thinking;
			}
		}

		const toolCalls: Array<{ name: string; args: string }> = [];
		if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (p.type === "toolCall") toolCalls.push({ name: p.name, args: JSON.stringify(p.arguments ?? {}) });
			}
		}

		if (content.length >= 50 || toolCalls.length > 0) {
			state.recentMessages.push({
				content,
				thinking: thinking || undefined,
				toolCalls: toolCalls.length ? toolCalls : undefined,
				timestamp: Date.now(),
				turnIndex: state.recentMessages.length,
			});
		}
		if (state.recentMessages.length > config.detectionWindow + 5) {
			state.recentMessages = state.recentMessages.slice(-(config.detectionWindow + 5));
		}

		const detections = detectLoops(state, config);
		processDetections(detections, interventionMessage);

		if (config.notifyOnDetection && detections.length && state.currentLevel > 0) {
			const lvl = ["", "warning", "force", "abort"][state.currentLevel];
			ctx.ui.notify(`antiloop: ${lvl} — ${detections[0].description}`, state.currentLevel >= 2 ? "error" : "warning");
		}
	});

	pi.on("input", async () => {
		if (!config.enabled) return;
		state.lastUserMessageTime = Date.now();
		if (state.consecutiveDetections > 0) state.consecutiveDetections = Math.max(0, state.consecutiveDetections - 2);
		if (state.consecutiveDetections < config.warningThreshold) {
			state.currentLevel = 0;
			state.inForcedBreak = false;
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async () => {
		if (!config.enabled || !rt.pendingIntervention) return;
		const msg = rt.pendingIntervention;
		rt.pendingIntervention = null;
		return {
			message: { customType: "antiloop-intervention", content: msg, display: true },
		};
	});

	pi.on("context", async (event) => {
		if (!config.enabled || state.currentLevel < 2) return;
		const msgs = [...event.messages];
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "assistant") {
				const m = msgs[i] as { content: string | Array<{ type: string; text?: string }> };
				const inject = "\n\n[antiloop] break out of loop — try a different approach.";
				if (typeof m.content === "string") m.content += inject;
				else if (Array.isArray(m.content)) m.content.push({ type: "text", text: inject });
				break;
			}
		}
		return { messages: msgs };
	});

	pi.on("turn_end", async (_e, ctx) => {
		if (config.enabled) updateStatus(ctx);
	});

	pi.on("session_start", async (_e, ctx) => {
		// re-read config and reset state for a fresh session
		Object.assign(config, loadConfig());
		state = newState();
		rt.pendingIntervention = null;
		updateStatus(ctx);
	});

	pi.registerCommand("antiloop", {
		description: "antiloop: detect & break reasoning loops",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["enable", "disable", "status", "config", "log", "reset", "test"];
			return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const { handleCommand } = await import("./commands.ts");
			await handleCommand(args, ctx, rt);
		},
	});
}


