// antiloop — similarity + detection engine. Lazy-loaded on first message_end.

import type { AntiloopConfig, AntiloopState, LoopDetection, TrackedMessage, TrackedToolCall } from "./types.ts";

const MIN_CONTENT_LENGTH = 50;

function normalizeText(t: string): string {
	return t.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}

function levenshtein(a: string, b: string): number {
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const m: number[][] = [];
	for (let i = 0; i <= b.length; i++) m[i] = [i];
	for (let j = 0; j <= a.length; j++) m[0][j] = j;
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
				? m[i - 1][j - 1]
				: Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
		}
	}
	return m[b.length][a.length];
}

function ngrams(text: string, n: number): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i <= text.length - n; i++) out.add(text.substring(i, i + n));
	return out;
}

function opening(text: string, n = 10): string {
	return normalizeText(text.split(/\s+/).slice(0, n).join(" "));
}

function similarity(a: string, b: string): number {
	if (a.length < MIN_CONTENT_LENGTH || b.length < MIN_CONTENT_LENGTH) return 0;
	if (a === b) return 1;
	const na = normalizeText(a);
	const nb = normalizeText(b);
	if (na.length < 20 || nb.length < 20) return 0;
	if (na === nb) return 1;
	if (na.length < 100 && nb.length < 100) {
		const max = Math.max(na.length, nb.length);
		return 1 - levenshtein(na, nb) / max;
	}
	const ga = ngrams(na, 3);
	const gb = ngrams(nb, 3);
	let inter = 0;
	for (const x of ga) if (gb.has(x)) inter++;
	const uni = ga.size + gb.size - inter;
	return inter / uni;
}

/**
 * Normalized, size-capped tail of a tool result, prefixed with ok/err so a
 * change between success and failure is always a "different outcome".
 * Stable against PID / timestamp noise at the tail of command output.
 */
export function resultFingerprint(
	parts: Array<{ type: string; text?: string }>,
	isError: boolean,
): string | undefined {
	let text = "";
	for (const p of parts) if (p.type === "text" && typeof p.text === "string") text += p.text;
	const norm = normalizeText(text);
	if (!norm.length) return undefined;
	return `${isError ? "err" : "ok"}|${norm.slice(-400)}`;
}

/** Same outcome = identical fingerprint, or high similarity of the tails. */
function sameOutcome(a: string, b: string, threshold: number): boolean {
	if (a === b) return true;
	// Fingerprints are already normalized + capped, so short ones can be
	// compared with edit distance directly — similarity() bails under 50 chars
	// and would wrongly veto small outputs with harmless noise (PIDs, times).
	if (a.length < 100 && b.length < 100) {
		const max = Math.max(a.length, b.length);
		const s = max ? 1 - levenshtein(a, b) / max : 1;
		return s >= threshold;
	}
	const s = similarity(a, b);
	return s >= threshold && s > 0;
}

function toolCallsSimilar(
	c1: TrackedToolCall[],
	c2: TrackedToolCall[],
	threshold: number,
	resultThreshold: number,
): boolean {
	if (c1.length !== c2.length) return false;
	// Empty call lists carry no repetition evidence — never treat them as a match.
	if (!c1.length) return false;
	for (let i = 0; i < c1.length; i++) {
		if (c1[i].name !== c2[i].name) return false;
		if (similarity(c1[i].args, c2[i].args) < threshold) return false;
		// Result veto: the same command producing a different outcome is
		// progress (a retry that fixed the problem), not a loop. Only applies
		// when both runs actually captured a result.
		const r1 = c1[i].result;
		const r2 = c2[i].result;
		if (r1 && r2 && !sameOutcome(r1, r2, resultThreshold)) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Task-stream recognition (batch work).
//
// Extensions like `punched` (append lines to pi.md) or `plan` (add tasks) make
// the model call the SAME tool many times in a row with DIFFERENT content:
// N distinct tasks of the same type — "adding line 1…N to a doc", "adding task
// 1…N to the plan". That is not a reasoning loop, and antiloop must not fire.
//
// A tool is an active task stream when, inside the detection window, it was
// called at least taskStreamMinCalls times and NO two calls are "twins"
// (args ≥ taskStreamTwinThreshold similar). Twins = the same task repeated;
// a stream with twins is indistinguishable from a loop and stays detected.
// The check is name-agnostic: any extension tool used as a batch is covered.
// ---------------------------------------------------------------------------

/** Near-identity of two argument payloads — unlike similarity() it works on
 * short args (JSON templates like {"action":"add",...} are < 50 chars, where
 * similarity() bails to 0).
 */
function argsTwin(a: string, b: string, threshold: number): boolean {
	const na = normalizeText(a);
	const nb = normalizeText(b);
	if (!na.length || !nb.length) return na === nb;
	if (na === nb) return true;
	if (na.length < 100 && nb.length < 100) {
		const max = Math.max(na.length, nb.length);
		return max > 0 && 1 - levenshtein(na, nb) / max >= threshold;
	}
	return similarity(a, b) >= threshold;
}

/**
 * Map of tool name → call count for tools currently used as a homogeneous
 * task stream in the given window. Empty map = no batch work recognized.
 */
export function detectTaskStreams(
	win: TrackedMessage[],
	config: AntiloopConfig,
): Map<string, number> {
	const streams = new Map<string, number>();
	if (!config.detectTaskStreams || win.length < config.taskStreamMinCalls) return streams;

	const callsByName = new Map<string, string[]>();
	for (const m of win) {
		for (const tc of m.toolCalls ?? []) {
			const arr = callsByName.get(tc.name) ?? [];
			arr.push(tc.args);
			callsByName.set(tc.name, arr);
		}
	}

	for (const [name, argsList] of callsByName) {
		if (argsList.length < config.taskStreamMinCalls) continue;
		let twins = 0;
		for (let i = 0; i < argsList.length; i++) {
			for (let j = i + 1; j < argsList.length; j++) {
				if (argsTwin(argsList[i], argsList[j], config.taskStreamTwinThreshold)) twins++;
			}
		}
		// Every call is a distinct task → batch work, exempt from loop detection.
		if (twins === 0) streams.set(name, argsList.length);
	}
	return streams;
}

export function detectLoops(state: AntiloopState, config: AntiloopConfig): LoopDetection[] {
	const out: LoopDetection[] = [];
	const msgs = state.recentMessages;
	if (msgs.length < 2) return out;
	const start = Math.max(0, msgs.length - config.detectionWindow);
	const win = msgs.slice(start);
	const now = Date.now();

	// Task-stream gate: if the window is a homogeneous batch (same extension
	// tool called with DISTINCT content ≥ taskStreamMinCalls times), that tool
	// is exempt from tool-loop detection, and text/thinking/structural
	// detections that only involve batch messages are suppressed too — the
	// model is doing N different tasks of the same type, not looping.
	const streams = detectTaskStreams(win, config);
	const batchAt = new Set<number>();
	win.forEach((m, idx) => {
		const calls = m.toolCalls;
		if (calls && calls.length && calls.every((c) => (streams.get(c.name) ?? 0) >= config.taskStreamMinCalls)) {
			batchAt.add(start + idx);
		}
	});
	const allBatch = (idxs: number[]): boolean => idxs.every((i) => batchAt.has(i));

	if (config.detectTextLoops) {
		const last = win[win.length - 1];
		if (last.content.length >= MIN_CONTENT_LENGTH) {
			for (let i = 0; i < win.length - 1; i++) {
				if (win[i].content.length < MIN_CONTENT_LENGTH) continue;
				const s = similarity(last.content, win[i].content);
				if (s >= config.similarityThreshold && !allBatch([start + i, msgs.length - 1])) {
					out.push({
						type: "text",
						similarity: s,
						messageIndices: [start + i, msgs.length - 1],
						description: `text similarity ${(s * 100).toFixed(0)}% with msg ${start + i + 1}`,
						timestamp: now,
					});
				}
			}
		}
		if (win.length >= 3) {
			const opens = win.map((m, idx) => ({ o: opening(m.content), idx }))
				.filter((x) => x.o.length >= 20);
			if (opens.length >= 3) {
				const last = opens[opens.length - 1].o;
				let n = 0;
				for (let i = 0; i < opens.length - 1; i++) {
					if (similarity(last, opens[i].o) > 0.9) n++;
				}
				if (n >= 2 && !allBatch([msgs.length - 1])) {
					out.push({
						type: "structural",
						similarity: 0.9,
						messageIndices: [msgs.length - 1],
						description: `repeated opening (${n + 1} similar starts)`,
						timestamp: now,
					});
				}
			}
		}
	}

	if (config.detectToolLoops) {
		const last = win[win.length - 1];
		const lastCalls = last.toolCalls;
		// A message whose calls are all task-stream tools is batch work — skip
		// it entirely (the stream gate already proved the calls are distinct).
		if (lastCalls && lastCalls.length && !batchAt.has(msgs.length - 1)) {
			const matched: number[] = [];
			for (let i = 0; i < win.length - 1; i++) {
				const prev = win[i].toolCalls;
				if (prev && toolCallsSimilar(lastCalls, prev, config.toolSimilarityThreshold, config.resultSimilarityThreshold)) {
					matched.push(start + i);
				}
			}
			// A single overlapping command (shared scaffolding in a long bash
			// call) is NOT a loop — the same call set must recur at least
			// minToolRepeatCount times inside the window before we flag it.
			if (matched.length >= config.minToolRepeatCount) {
				out.push({
					type: "tool",
					similarity: 1,
					messageIndices: [...matched, msgs.length - 1],
					description: `repeated ${matched.length + 1}x: ${lastCalls.map((t) => t.name).join(", ")}`,
					timestamp: now,
				});
			}
		}
	}

	if (config.detectThinkingLoops) {
		const last = win[win.length - 1];
		if (last.thinking && last.thinking.length > 50) {
			for (let i = 0; i < win.length - 1; i++) {
				if (win[i].thinking && win[i].thinking!.length > 50) {
					const s = similarity(last.thinking, win[i].thinking!);
					if (s >= config.similarityThreshold && !allBatch([start + i, msgs.length - 1])) {
						out.push({
							type: "thinking",
							similarity: s,
							messageIndices: [start + i, msgs.length - 1],
							description: `thinking similarity ${(s * 100).toFixed(0)}%`,
							timestamp: now,
						});
					}
				}
			}
		}
	}

	return out;
}

export function interventionMessage(level: 1 | 2 | 3, detections: LoopDetection[]): string {
	const det = detections.map((d) => `- ${d.description}`).join("\n");
	if (level === 1) {
		return `[antiloop] ⚠️ loop warning\n${det}\nvary approach — try a different strategy.`;
	}
	if (level === 2) {
		return `[antiloop] 🛑 stuck in loop\n${det}\nstop, change approach, do NOT repeat previous tool calls or reasoning.`;
	}
	return `[antiloop] 🚨 persistent loop\n${det}\nunable to break automatically — provide new instructions.`;
}

// ---------------------------------------------------------------------------
// Self-test — runs the REAL engine so it tracks future calibration changes.
// Includes the regression case that motivated the 0.95 tool threshold:
// sequential bash operations that share scaffolding (env setup, model path,
// most flags) are NOT a loop, even when they score 0.8–0.94 similar.
// ---------------------------------------------------------------------------

export function runSelfTest(): string[] {
	const out: string[] = [];
	const pct = (s: number) => `${(s * 100).toFixed(0)}%`;

	// --- text similarity ---
	const textSame = "I will read the file first to understand the structure before editing anything at all";
	const textNear = "I will read the file first to understand the layout before editing anything at all";
	const textDiff = "The quick brown fox jumps over the lazy dog near the river bank and keeps running";
	const s1 = similarity(textSame, textSame);
	const s2 = similarity(textSame, textNear);
	const s3 = similarity(textSame, textDiff);
	out.push(`text identical      → ${pct(s1)} (exp 100%) ${s1 >= 0.99 ? "✅" : "❌"}`);
	out.push(`text near-identical → ${pct(s2)} (exp ≥ 80%) ${s2 >= 0.8 ? "✅" : "❌"}`);
	out.push(`text unrelated      → ${pct(s3)} (exp < 50%) ${s3 < 0.5 ? "✅" : "❌"}`);

	// --- tool calls (default thresholds: 95% args similarity, 2 prior repeats) ---
	const common =
		"cd /home/j/llm && ulimit -l unlimited 2>/dev/null; export ROCBLAS_USE_HIPBLASLT=1 HIP_VISIBLE_DEVICES=1; " +
		"setsid ./kingjones30-boosted/build-unroll/bin/llama-server " +
		"-m /home/j/llm/ling-rocmfp4/Ling-3.0-flash-ROCmFP4-STRIX-MTP-Q4_0-00001-of-00002.gguf " +
		"-dev ROCm0 -ngl 999 -fa on -c 8192 -fit off -np 1 -sm row -ub 2048 " +
		"--spec-type draft-mtp --spec-draft-n-max 2 --spec-draft-n-min 0 --spec-draft-p-min 0.4 " +
		"--reasoning off --jinja --host 127.0.0.1 --port 8093 --no-webui";
	const sweepRun1 = `${common} -b 2048 -ctk q8_0 -ctv turbo4 > /tmp/sweep-turbo4.log 2>&1 & echo $!; sleep 60; grep "model loaded" /tmp/sweep-turbo4.log`;
	const sweepRun2 = `${common} -b 8192 -ctk f16 -ctv f16 > /tmp/sweep-b8192.log 2>&1 & echo $!; sleep 70; grep "model loaded" /tmp/sweep-b8192.log`;

	const t1 = toolCallsSimilar([{ name: "bash", args: sweepRun1 }], [{ name: "bash", args: sweepRun1 }], 0.95, 0.8);
	const t2 = toolCallsSimilar([{ name: "bash", args: sweepRun1 }], [{ name: "bash", args: sweepRun2 }], 0.95, 0.8);
	const t2old = toolCallsSimilar([{ name: "bash", args: sweepRun1 }], [{ name: "bash", args: sweepRun2 }], 0.8, 0.8);
	const t3 = toolCallsSimilar([{ name: "bash", args: sweepRun1 }], [{ name: "read", args: "{}" }], 0.95, 0.8);
	const t4 = toolCallsSimilar([], [], 0.95, 0.8);
	out.push(`tool identical cmd  → ${t1 ? "match" : "no match"} (exp match) ${t1 ? "✅" : "❌"}`);
	out.push(`tool sweep (flags)  → ${t2 ? "match" : "no match"} @95% (exp no match) ${!t2 ? "✅" : "❌"}`);
	out.push(`tool sweep (old 80%)→ ${t2old ? "match" : "no match"} @80% (exp match — was the false positive) ${t2old ? "✅" : "❌"}`);
	out.push(`tool different tool → ${t3 ? "match" : "no match"} (exp no match) ${!t3 ? "✅" : "❌"}`);
	out.push(`tool empty lists    → ${t4 ? "match" : "no match"} (exp no match) ${!t4 ? "✅" : "❌"}`);

	// --- result veto: same command, different outcome = progress, not a loop ---
	const rErr = resultFingerprint([{ type: "text", text: "error: invalid argument: ROCm0\nPID 74970" }], true)!;
	const rErr2 = resultFingerprint([{ type: "text", text: "error: invalid argument: ROCm0\nPID 77788" }], true)!;
	const rOk = resultFingerprint([{ type: "text", text: "model loaded\nserver is listening on http://127.0.0.1:8093" }], false)!;
	const sameCmdSameOut = toolCallsSimilar(
		[{ name: "bash", args: sweepRun1, result: rErr }],
		[{ name: "bash", args: sweepRun1, result: rErr2 }],
		0.95, 0.8,
	);
	const sameCmdDiffOut = toolCallsSimilar(
		[{ name: "bash", args: sweepRun1, result: rErr }],
		[{ name: "bash", args: sweepRun1, result: rOk }],
		0.95, 0.8,
	);
	out.push(`result same outcome  → ${sameCmdSameOut ? "match" : "no match"} (exp match — PID noise ok) ${sameCmdSameOut ? "✅" : "❌"}`);
	out.push(`result diff outcome  → ${sameCmdDiffOut ? "match" : "no match"} (exp no match — error→success is progress) ${!sameCmdDiffOut ? "✅" : "❌"}`);

	// --- task streams: extension batch work is NOT a loop ---
	// punched_log / plan_manager / obsidian_* style tools: the model calls the
	// SAME tool N times with DIFFERENT content ("add line 1…N", "add task 1…N").
	// Near-identical template args (98.9% similar here) WOULD match the tool
	// detector; the task-stream gate must suppress the whole window instead.
	const mk = (content: string, toolCalls?: TrackedToolCall[]): TrackedMessage =>
		({ content, toolCalls, timestamp: Date.now(), turnIndex: 0 });
	const noteArgs = (x: string) =>
		JSON.stringify({ type: "note", title: `task ${x}`, body: "append this line to the project memory document so context is preserved" });
	const tcfg: AntiloopConfig = {
		enabled: true, warningThreshold: 2, forceBreakThreshold: 3, abortThreshold: 0,
		similarityThreshold: 0.75, toolSimilarityThreshold: 0.95, minToolRepeatCount: 2,
		resultSimilarityThreshold: 0.8, detectToolLoops: true, detectThinkingLoops: true,
		detectTextLoops: true, notifyOnDetection: true, maxHistoryEntries: 100,
		detectionWindow: 10, interactiveFooter: true, toggleShortcut: "esc+a",
		detectTaskStreams: true, taskStreamMinCalls: 3, taskStreamTwinThreshold: 0.99,
	};
	const asState = (recentMessages: TrackedMessage[]): AntiloopState =>
		({ recentMessages, detections: [], activeTaskStreams: [], currentLevel: 0,
			consecutiveDetections: 0, inForcedBreak: false, totalDetections: 0,
			lastUserMessageTime: 0, lastDetectedTurnIndex: -1 });
	const NARR = "Now I will append the next decision entry to the project memory document so we keep the context.";

	// 1) punched_log batch: 3 DIFFERENT appends (args 98.9% similar, NOT twins)
	//    → stream recognized, tool + text + structural all suppressed.
	const batchMsgs = [
		mk(NARR, [{ name: "punched_log", args: noteArgs("1") }]),
		mk(NARR, [{ name: "punched_log", args: noteArgs("2") }]),
		mk(NARR, [{ name: "punched_log", args: noteArgs("3") }]),
	];
	const batchWin = batchMsgs.slice(-tcfg.detectionWindow);
	const batchStreams = detectTaskStreams(batchWin, tcfg);
	const batchDet = detectLoops(asState(batchMsgs), tcfg);
	out.push(`batch stream detected  → ${batchStreams.get("punched_log") === 3 ? `punched_log×${batchStreams.get("punched_log")}` : "no"} (exp punched_log×3) ${batchStreams.get("punched_log") === 3 ? "✅" : "❌"}`);
	out.push(`batch no detections    → ${batchDet.length === 0 ? "silent" : `${batchDet.map((d) => d.type).join(",")}`} (exp silent — 98.9% args would match without gate) ${batchDet.length === 0 ? "✅" : "❌"}`);

	// 2) genuine loop: SAME call repeated verbatim → twins → stream inactive,
	//    tool detection must still fire.
	const loopMsgs = [
		mk(NARR, [{ name: "punched_log", args: noteArgs("1") }]),
		mk(NARR, [{ name: "punched_log", args: noteArgs("1") }]),
		mk(NARR, [{ name: "punched_log", args: noteArgs("1") }]),
	];
	const loopDet = detectLoops(asState(loopMsgs), tcfg);
	out.push(`loop still detected     → ${loopDet.some((d) => d.type === "tool") ? "tool" : "no"} (exp tool — identical repeats are NOT a stream) ${loopDet.some((d) => d.type === "tool") ? "✅" : "❌"}`);

	// 3) coexistence: batch tool + a genuinely repeated bash command in the
	//    same messages → the bash loop must still be flagged.
	const loopCmd = "cd /tmp && sleep 1 && echo retrying the same build step again and again forever";
	const mixedMsgs = [
		mk(NARR, [{ name: "punched_log", args: noteArgs("1") }, { name: "bash", args: loopCmd }]),
		mk(NARR, [{ name: "punched_log", args: noteArgs("2") }, { name: "bash", args: loopCmd }]),
		mk(NARR, [{ name: "punched_log", args: noteArgs("3") }, { name: "bash", args: loopCmd }]),
	];
	const mixedDet = detectLoops(asState(mixedMsgs), tcfg);
	out.push(`loop survives batch gate→ ${mixedDet.some((d) => d.type === "tool") ? "tool" : "no"} (exp tool — bash repeats are real) ${mixedDet.some((d) => d.type === "tool") ? "✅" : "❌"}`);

	// 4) below min calls: 2 distinct appends → no stream (could be coincidence).
	const twoMsgs = [mk("a", [{ name: "punched_log", args: noteArgs("1") }]), mk("b", [{ name: "punched_log", args: noteArgs("2") }])];
	const twoStreams = detectTaskStreams(twoMsgs, tcfg);
	out.push(`stream needs ≥3 calls   → ${twoStreams.size === 0 ? "no stream" : "stream"} (exp no stream at 2 calls) ${twoStreams.size === 0 ? "✅" : "❌"}`);

	return out;
}
