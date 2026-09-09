/**
 * antiloop — detect reasoning loops and intervene.
 * Hooks: message_end, tool_call, input, turn_end, session_start, session_shutdown.
 * Commands: /antiloop [enable|disable|status|config|log|reset|test]
 *
 * Intervention model (v1.5):
 *   warning (level 1) — informational only (notify). Never injects: an injected
 *     message at warning level made models stall on the unexpected message.
 *   force   (level 2) — a REAL user message is steered into the running agent
 *     (pi.sendUserMessage, deliverAs "steer"); pi delivers it right after the
 *     current tool results, immediately before the next LLM call, so it lands at
 *     the exact spot where the model anchors — even a deterministic model stuck
 *     on an identical context tail must respond to it. One steer per episode.
 *     If the model ignores the steer and repeats the same message verbatim
 *     (≥98% similar / identical tool loop) ignoredSteerLimit times, antiloop
 *     hard-stops the run (ctx.abort).
 *   abort   (level 3, opt-in via abortThreshold) — stops the run outright.
 *
 * v1.6 adds the intra-message degenerate detector: a model whose decoder
 * anchors on a token repeats it hundreds of times INSIDE one message / tool
 * call (the real 46 KB bash "noguerol ×5145" meltdown). That needs no peer
 * message, so it is caught at message_end — BEFORE the tool calls execute —
 * and degenerate bash commands are additionally blocked in the tool_call
 * hook (blockDegenerateBash). One degenerate turn counts degenerateTurnWeight
 * (2) consecutive points: warning on first sight, force-break steer on the
 * second consecutive meltdown, hard stop shortly after if it keeps repeating.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
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
		steerDelivered: false,
		ignoredSteerCount: 0,
		turnSeq: 0,
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

	/** Status text shown in the footer: "🔄 a:on" / "🔄 a:off" per spec. */
	function antiloopStatusText(): string {
		return config.enabled ? "🔄 a:on" : "🔄 a:off";
	}

	function updateStatus(ctx: ExtensionContext): void {
		// Always set a status line so the footer shows on/off either way.
		ctx.ui.setStatus("antiloop", antiloopStatusText());
		activeTui?.requestRender();
	}

	const rt: Runtime = { config, state, updateStatus, refreshFooter: installFooter };

	/** Toggle enable/disable, persisting config and refreshing the footer. */
	function toggleEnabled(ctx: ExtensionContext): void {
		config.enabled = !config.enabled;
		saveConfig(config);
		ctx.ui.notify(`antiloop: ${config.enabled ? "ON" : "OFF"}`, "info");
		updateStatus(ctx);
	}

	/** Set the escalation level; keeps the derived inForcedBreak flag in sync. */
	function applyLevel(level: 0 | 1 | 2 | 3): void {
		state.currentLevel = level;
		state.inForcedBreak = level >= 2;
	}

	/** level from the current consecutive count (lazy import wrapper). */
	async function levelForConsecutive(): Promise<0 | 1 | 2 | 3> {
		const { nextLevel } = await import("./detect.ts");
		return nextLevel(state.consecutiveDetections, config);
	}

	/**
	 * Force break: steer a real user message into the running agent. pi delivers
	 * "steer" messages right after the current tool results and BEFORE the next
	 * LLM call — the model must respond to it, which breaks the identical-context
	 * anchoring that verbatim loops feed on. (before_agent_start injection was
	 * abandoned: it only fires on the NEXT user prompt, never mid-run — the exact
	 * reason antiloop previously failed to cut autonomous tool loops.)
	 */
	function deliverForceBreak(ctx: ExtensionContext, detections: LoopDetection[]): void {
		const detail = detections[0]?.description ?? "repeated message/tool calls";
		try {
			pi.sendUserMessage(
				`[antiloop] 🛑 Force break — loop detected (${detail}; ${state.consecutiveDetections} consecutive).\n` +
					"Stop repeating previous text, reasoning and tool calls, and change approach now.\n" +
					"If you cannot make progress with a different approach, do NOT call more tools — " +
					"reply to the user briefly: what you tried, what is blocking you, and what you need.",
				{ deliverAs: "steer" },
			);
			state.steerDelivered = true;
			if (config.notifyOnDetection) {
				ctx.ui.notify(`antiloop: force break — ${detail} (break message sent to the model)`, "error");
			}
		} catch (err) {
			// Steer could not be queued (edge: run ended between detection and queue).
			// Stay armed so the next steerable turn delivers the break.
			state.steerDelivered = false;
			if (config.notifyOnDetection) {
				ctx.ui.notify(
					`antiloop: force break — ${detail} (could not inject: ${err instanceof Error ? err.message : String(err)})`,
					"error",
				);
			}
		}
	}

	/**
	 * Hard stop: abort the current agent run (fire-and-forget — never awaited, so
	 * the turn_end handler cannot deadlock on waitForIdle) and tell the user.
	 */
	function hardStop(ctx: ExtensionContext, text: string): void {
		try {
			ctx.abort();
		} catch {
			// abort must never throw out of a hook.
		}
		if (config.notifyOnDetection) {
			ctx.ui.notify(text, "error");
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
			activeTui = undefined;
			return;
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;

			let pendingEsc = false;
			const shortcut = config.toggleShortcut;
			const unsubInput =
				shortcut === "off"
					? undefined
					: ctx.ui.onTerminalInput?.((data: string) => {
							if (config.toggleShortcut === "off") return undefined;
							// Only honor the toggle while idle. ESC is also pi's interrupt key:
							// an 'a' typed right after cancelling a stuck run is almost always
							// normal typing, not a toggle — arming while the agent runs caused
							// accidental silent toggles to OFF mid-session.
							if (!ctx.isIdle()) {
								pendingEsc = false;
								return undefined;
							}
							if (data === "\x1b") {
								pendingEsc = true;
								return undefined;
							}
							if (pendingEsc) {
								pendingEsc = false;
								if (data === "a") {
									toggleEnabled(ctx);
								}
								return undefined;
							}
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

					const status = antiloopStatusText();
					const colored = config.enabled ? theme.fg("accent", status) : theme.fg("dim", status);
					const hint =
						config.toggleShortcut !== "off"
							? theme.fg("dim", `  [${config.toggleShortcut}] toggle`)
							: theme.fg("dim", "  [/antiloop] toggle");
					lines.push(truncateToWidth(colored + hint, width));

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

					let info = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					if (branch) info += ` (${branch})`;
					const usage = ctx.getContextUsage();
					const cw = usage?.contextWindow ?? ctx.model?.contextWindow;
					if (cw && usage && usage.percent !== null) info += ` · ctx ${Math.round(usage.percent)}%`;
					if (ctx.model) info += ` · ${ctx.model.id}`;
					lines.push(truncateToWidth(theme.fg("dim", info), width));

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

	pi.on("message_end", async (event, ctx) => {
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
				// Monotonic: the array is trimmed below (detectionWindow + 5), so
				// recentMessages.length would repeat after the first trim and the
				// turn_end dedupe guard (turnIndex === lastDetectedTurnIndex) would
				// skip every later message — antiloop going blind mid-session.
				turnIndex: state.turnSeq++,
			});
		}
		if (state.recentMessages.length > config.detectionWindow + 5) {
			state.recentMessages = state.recentMessages.slice(-(config.detectionWindow + 5));
		}

		// v1.6 — degenerate meltdowns are handled HERE, at message_end, because
		// turn_end only fires after tool execution (too late to stop the 46 KB
		// "noguerol ×5000" bash from running) and an aborted generation may never
		// reach turn_end at all. The signal is self-contained (one pathological
		// payload, no peer message) so the full escalation ladder runs right now;
		// the turn-guard makes the later turn_end pass skip this message and no
		// detection is double-counted.
		if (!config.detectDegenerate) return;
		const { scanMessageDegenerate, degenerateDescription, nextLevel, isVerbatimRepeat } = await import("./detect.ts");
		const hit = scanMessageDegenerate(content, toolCalls, config);
		if (!hit) return;
		const tracked = state.recentMessages[state.recentMessages.length - 1];
		if (tracked) state.lastDetectedTurnIndex = tracked.turnIndex;
		const prevLevel = state.currentLevel;
		state.consecutiveDetections += Math.max(1, config.degenerateTurnWeight);
		state.totalDetections++;
		const det: LoopDetection = {
			type: "degenerate",
			similarity: 1,
			messageIndices: [state.recentMessages.length - 1],
			description: degenerateDescription(hit),
			timestamp: Date.now(),
		};
		state.detections.push(det);
		if (state.detections.length > config.maxHistoryEntries) {
			state.detections = state.detections.slice(-config.maxHistoryEntries);
		}
		applyLevel(nextLevel(state.consecutiveDetections, config));
		const level = state.currentLevel;

		if (level === 1 && prevLevel < 1) {
			// Warning: informational only (never injects — a warning must not stall).
			if (config.notifyOnDetection) {
				ctx.ui.notify(`antiloop: warning — ${det.description}`, "warning");
			}
		} else if (level === 2) {
			if (!state.steerDelivered) {
				// Steer the break message before the next LLM call. The degenerate bash
				// itself is blocked by the tool_call gate, so the model sees the block
				// reason + the steer together and can still change approach.
				if (ctx.signal !== undefined) {
					deliverForceBreak(ctx, [det]);
				} else if (prevLevel < 2 && config.notifyOnDetection) {
					ctx.ui.notify(`antiloop: force break — ${det.description}`, "error");
				}
			} else if (isVerbatimRepeat([det])) {
				// The model produced degenerate output AGAIN after the break message:
				// count it; once the ignore limit is hit the run is cut for good.
				state.ignoredSteerCount++;
				if (state.ignoredSteerCount >= config.ignoredSteerLimit) {
					hardStop(
						ctx,
						`antiloop: abort — degenerate output repeated ${state.ignoredSteerCount}× after the force break — run stopped; provide new instructions`,
					);
				}
			}
		} else if (level === 3) {
			// abortThreshold configured and reached: stop the run BEFORE the degenerate
			// tool calls can execute (ctx.abort kills the pending tool batch).
			hardStop(ctx, `antiloop: abort — ${det.description} — run stopped; provide new instructions`);
		}
		updateStatus(ctx);
	});

	pi.on("input", async (event) => {
		if (!config.enabled) return;
		// Messages queued by extensions (including antiloop's own force-break
		// steer) are NOT user input: they must not cool down the escalation or
		// re-arm the steer — that would defeat the force break.
		const source = (event as { source?: string } | undefined)?.source;
		if (source === "extension") return { action: "continue" };

		state.lastUserMessageTime = Date.now();
		if (state.consecutiveDetections > 0) {
			state.consecutiveDetections = Math.max(0, state.consecutiveDetections - 2);
		}
		// A real user message is a new chance: mirror the level off the cooled-down
		// counter and re-arm the force break so a fresh loop gets a fresh steer.
		applyLevel(await levelForConsecutive());
		state.steerDelivered = false;
		state.ignoredSteerCount = 0;
		return { action: "continue" };
	});

	/**
	 * v1.6 — degenerate bash gate. A meltdown message whose command repeats one
	 * word hundreds of times (the 46 KB "noguerol ×5145" SSH-wordlist brute
	 * force) must NEVER execute: it is pure context burn at best, and a real
	 * brute-force / destructive repetition at worst. message_end already
	 * escalated it; here we block the actual call before it runs. The block
	 * reason is fed back to the model as the tool error, so the next LLM call
	 * sees why the command was refused and can change approach.
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled || !config.detectDegenerate || !config.blockDegenerateBash) return;
		if (!isToolCallEventType("bash", event)) return;
		const { findDegenerateRepetition, degenerateDescription } = await import("./detect.ts");
		const hit = findDegenerateRepetition(event.input.command ?? "", config);
		if (!hit) return;
		return {
			block: true,
			reason: `[antiloop] blocked: ${degenerateDescription({ ...hit, where: "bash command" })} — this is stuck generation, not a real command. Do NOT retry it: stop and take one small, concrete step instead.`,
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled) return;
		const { detectLoops, detectTaskStreams, detectionTurnWeight, isVerbatimRepeat, nextLevel, resultFingerprint } = await import("./detect.ts");

		const last = state.recentMessages[state.recentMessages.length - 1];
		if (!last || last.turnIndex === state.lastDetectedTurnIndex) {
			updateStatus(ctx);
			return;
		}
		state.lastDetectedTurnIndex = last.turnIndex;

		if (last.toolCalls?.length && Array.isArray(event?.toolResults)) {
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
		const prevLevel = state.currentLevel;

		// ---- clean turn: cool down ----------------------------------------
		if (!detections.length) {
			if (state.consecutiveDetections > 0) state.consecutiveDetections--;
			applyLevel(nextLevel(state.consecutiveDetections, config));
			if (state.currentLevel === 0) {
				state.steerDelivered = false;
				state.ignoredSteerCount = 0;
			}
			updateStatus(ctx);
			return;
		}

		// ---- detection: escalate ------------------------------------------
		// Degenerate turns count degenerateTurnWeight (default 2) points so a
		// single intra-message meltdown already reaches the warning level.
		state.consecutiveDetections += detectionTurnWeight(detections, config);
		state.totalDetections++;
		state.detections.push(...detections);
		if (state.detections.length > config.maxHistoryEntries) {
			state.detections = state.detections.slice(-config.maxHistoryEntries);
		}
		applyLevel(nextLevel(state.consecutiveDetections, config));
		const level = state.currentLevel;

		// The steer is only picked up when the run keeps going after this turn.
		// On error/aborted stop reasons the agent loop returns immediately and the
		// queued message would go stale — stay armed and steer on a later turn.
		const stopReason = (event as { message?: { stopReason?: string } } | undefined)?.message?.stopReason;
		const steerable = stopReason !== "error" && stopReason !== "aborted" && ctx.signal !== undefined;

		if (level === 1 && prevLevel < 1) {
			// Warning: informational only (never injects — a warning must not stall).
			if (config.notifyOnDetection) {
				ctx.ui.notify(`antiloop: warning — ${detections[0].description}`, "warning");
			}
		} else if (level === 2) {
			if (!state.steerDelivered) {
				// First force-break turn of the episode: steer a break message
				// before the next LLM call.
				if (steerable) {
					deliverForceBreak(ctx, detections);
				} else if (prevLevel < 2 && config.notifyOnDetection) {
					ctx.ui.notify(`antiloop: force break — ${detections[0].description}`, "error");
				}
			} else if (isVerbatimRepeat(detections)) {
				// The model repeated the same message/call after being told to stop:
				// count it; once the ignore limit is hit the run is cut for good.
				state.ignoredSteerCount++;
				if (state.ignoredSteerCount >= config.ignoredSteerLimit) {
					hardStop(
						ctx,
						`antiloop: abort — the model repeated the same message ${state.ignoredSteerCount}× after the force break — run stopped; provide new instructions`,
					);
				}
			}
		} else if (level === 3) {
			// abortThreshold configured and reached: stop the run outright.
			hardStop(ctx, `antiloop: abort — ${detections[0].description} — run stopped; provide new instructions`);
		}

		updateStatus(ctx);
	});

	pi.on("session_start", async (_e, ctx) => {
		// re-read config and reset state for a fresh session
		Object.assign(config, loadConfig());
		state = newState();
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
