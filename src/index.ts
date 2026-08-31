/**
 * antiloop — detect reasoning loops and intervene.
 * Hooks: message_end, input, before_agent_start, context, turn_end, session_start, session_shutdown.
 * Commands: /antiloop [enable|disable|status|config|log|reset|test]
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig } from "./config.ts";
import type { AntiloopState, LoopDetection, Runtime, TrackedToolCall } from "./types.ts";

const ICONS = ["", "⚠️", "🛑", "🚨"] as const;
const LEVEL_NAMES = ["", "warning", "force", "abort"] as const;

function newState(): AntiloopState {
	return {
		recentMessages: [],
		detections: [],
		activeTaskStreams: [],
		currentLevel: 0,
		consecutiveDetections: 0,
		inForcedBreak: false,
		totalDetections: 0,
		lastUserMessageTime: 0,
		lastDetectedTurnIndex: -1,
	};
}

/** Compact pwd: ~-relative when inside $HOME, with trailing separator trimmed. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		const rel = cwd.slice(home.length).replace(/^[/\\]+/, "");
		return rel ? `~/${rel}` : "~";
	}
	return cwd;
}

export default function antiloopExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	let state = newState();

	/** TUI handle for forcing footer re-renders (set by the footer factory). */
	let activeTui: { requestRender(force?: boolean): void } | undefined;

	/** Status text shown in the footer: "(emoji_antiloop)(on/off)" per spec,
	 * plus active batch streams so a quiet antiloop is explainable. */
	function antiloopStatusText(): string {
		if (!config.enabled) return "🔄 antiloop(off)";
		const base =
			state.currentLevel === 0
				? "🔄 antiloop(on)"
				: `${ICONS[state.currentLevel]} antiloop(on)×${state.consecutiveDetections}`;
		if (state.activeTaskStreams.length) {
			const s = state.activeTaskStreams.map((x) => `${x.tool}×${x.count}`).join(", ");
			return `${base} · batch: ${s}`;
		}
		return base;
	}

	function updateStatus(ctx: ExtensionContext): void {
		// Always set a status line so the footer shows on/off either way.
		ctx.ui.setStatus("antiloop", antiloopStatusText());
		activeTui?.requestRender();
	}

	const rt: Runtime = { config, state, pendingIntervention: null, updateStatus, refreshFooter: installFooter };
	const setPending = (v: string | null) => { rt.pendingIntervention = v; };

	/** Toggle enable/disable, persisting config and refreshing the footer. */
	function toggleEnabled(ctx: ExtensionContext): void {
		config.enabled = !config.enabled;
		saveConfig(config);
		ctx.ui.notify(`antiloop: ${config.enabled ? "ON" : "OFF"}`, "info");
		updateStatus(ctx);
	}

	function processDetections(
		detections: LoopDetection[],
		interventionMessage: (level: 2 | 3, d: LoopDetection[]) => string,
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

		// Warning (level 1) is informational only: notify the user but DO NOT
		// inject any message into the conversation. Injecting at warning level
		// made the model respond to the warning, which could stall generation
		// even though hard-kill turns remained. Only force (2) / abort (3) inject.
		if (state.currentLevel >= 2) {
			setPending(interventionMessage(state.currentLevel as 2 | 3, detections));
			state.inForcedBreak = true;
		} else if (state.currentLevel === 1) {
			state.inForcedBreak = false;
		}
	}

	// ------------------------------------------------------------------
	// Interactive footer (TUI). Replaces the built-in footer with a line
	// per spec — "🔄 antiloop(on|off)" — plus live detection info, a
	// keyboard toggle (esc+a by default, configurable/off), and the
	// built-in footer's useful data (pwd, branch, ctx %, model) preserved.
	// ------------------------------------------------------------------
	function installFooter(ctx: ExtensionContext): void {
		if (!config.interactiveFooter || ctx.mode !== "tui") {
			ctx.ui.setFooter(undefined);
			return;
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;

			// Keyboard toggle from raw terminal input: escape followed by `a`.
			// We never consume the input, so typing is unaffected — ESC alone
			// passes through, and an accidental toggle is easily reversed.
			let pendingEsc = false;
			const shortcut = config.toggleShortcut;
			const unsubInput =
				shortcut === "off"
					? undefined
					: ctx.ui.onTerminalInput?.((data: string) => {
							if (config.toggleShortcut === "off") return undefined;
							if (data === "\x1b") {
								pendingEsc = true;
								return undefined;
							}
							if (pendingEsc && data === "a") {
								pendingEsc = false;
								toggleEnabled(ctx);
								return undefined;
							}
							pendingEsc = false;
							return undefined;
					  });

			return {
				dispose() {
					unsubInput?.();
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const lines: string[] = [];

					// Line 1: the spec indicator + toggle hint.
					const status = antiloopStatusText();
					const colored = config.enabled ? theme.fg("accent", status) : theme.fg("dim", status);
					const hint =
						config.toggleShortcut !== "off"
							? theme.fg("dim", `  [${config.toggleShortcut}] toggle`)
							: theme.fg("dim", "  [/antiloop] toggle");
					lines.push(truncateToWidth(colored + hint, width));

					// Line 2 (only while detecting): level + consecutive + last reason.
					if (state.currentLevel > 0) {
						const last = state.detections[state.detections.length - 1];
						const desc = last ? ` · ${last.description}` : "";
						lines.push(
							truncateToWidth(
								theme.fg("warning", `${LEVEL_NAMES[state.currentLevel]} ×${state.consecutiveDetections}${desc}`),
								width,
							),
						);
					}

					// Line 3: built-in footer data preserved (dim).
					let info = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					if (branch) info += ` (${branch})`;
					const usage = ctx.getContextUsage();
					const cw = usage?.contextWindow ?? ctx.model?.contextWindow;
					if (cw && usage && usage.percent !== null) info += ` · ctx ${Math.round(usage.percent)}%`;
					if (ctx.model) info += ` · ${ctx.model.id}`;
					lines.push(truncateToWidth(theme.fg("dim", info), width));

					// Line 4 (only when other extensions set statuses): keep them visible.
					const others = Array.from(footerData.getExtensionStatuses().entries())
						.filter(([k]) => k !== "antiloop")
						.map(([, v]) => v);
					if (others.length) {
						lines.push(truncateToWidth(theme.fg("dim", others.join("  ")), width));
					}

					return lines;
				},
			};
		});
	}

	pi.on("message_end", async (event) => {
		if (!config.enabled) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;

		let content = "";
		let thinking = "";
		if (typeof msg.content === "string") content = msg.content;
		else if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (p.type === "text") content += p.text;
				else if (p.type === "thinking") thinking += p.thinking;
			}
		}

		// Track the call with its id so turn_end can attach the execution result.
		const toolCalls: TrackedToolCall[] = [];
		if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (p.type === "toolCall") toolCalls.push({ name: p.name, args: JSON.stringify(p.arguments ?? {}), id: p.id });
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

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled) return;
		const { detectLoops, detectTaskStreams, interventionMessage, resultFingerprint } = await import("./detect.ts");

		const last = state.recentMessages[state.recentMessages.length - 1];
		// A turn whose assistant message wasn't tracked (short text, no tools)
		// must not re-run detection on the previous message — skip it.
		if (!last || last.turnIndex === state.lastDetectedTurnIndex) {
			updateStatus(ctx);
			return;
		}
		state.lastDetectedTurnIndex = last.turnIndex;

		// Attach execution results to the message that just finished its turn.
		// Detection runs here (not at message_end) because the results — the
		// signal that distinguishes "stuck loop" from "making progress" — only
		// exist after the tools have executed.
		if (last.toolCalls?.length && event.toolResults.length) {
			const byId = new Map<string, string | undefined>();
			for (const tr of event.toolResults) byId.set(tr.toolCallId, resultFingerprint(tr.content, tr.isError));
			for (const tc of last.toolCalls) {
				if (tc.id && tc.result === undefined) {
					const r = byId.get(tc.id);
					if (r !== undefined) tc.result = r;
				}
			}
		}

		// Recomputed batch streams (punched_log / plan_manager / … used as a
		// homogeneous task stream) — shown in the footer so the user sees why
		// antiloop stays quiet while the model performs N tasks of one type.
		const winStart = Math.max(0, state.recentMessages.length - config.detectionWindow);
		state.activeTaskStreams = Array.from(
			detectTaskStreams(state.recentMessages.slice(winStart), config).entries(),
		).map(([tool, count]) => ({ tool, count }));

		const detections = detectLoops(state, config);
		processDetections(detections, interventionMessage);

		if (config.notifyOnDetection && detections.length && state.currentLevel > 0) {
			const lvl = ["", "warning", "force", "abort"][state.currentLevel];
			ctx.ui.notify(`antiloop: ${lvl} — ${detections[0].description}`, state.currentLevel >= 2 ? "error" : "warning");
		}
		updateStatus(ctx);
	});

	pi.on("session_start", async (_e, ctx) => {
		// re-read config and reset state for a fresh session
		Object.assign(config, loadConfig());
		state = newState();
		rt.pendingIntervention = null;
		installFooter(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		// Restore the built-in footer on shutdown (in case another extension
		// installs its own footer later, or the TUI is torn down).
		ctx.ui.setFooter(undefined);
		activeTui = undefined;
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
