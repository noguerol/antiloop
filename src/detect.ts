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

// ---------------------------------------------------------------------------
// Intra-message degenerate repetition (v1.6).
//
// The "noguerol ×5145" class (verified against a real session — /home/j
// 2026-09-09T15-43: ONE 46 KB bash call whose SSH username list repeats a
// single word 5145 times, a run of 5140 — 99% of the payload). A model whose
// decoder anchors on a token stops producing NEW output: it repeats the same
// word hundreds of times INSIDE one message or tool call. The cross-message
// detectors (text / tool / thinking / structural) all need >= 2 similar
// messages and cannot see this — the meltdown happened exactly once, inside a
// single call, and antiloop stayed silent until the user ESC'd.
//
// This detector is self-contained: it flags the FIRST such payload, no peer
// message required, and it is cheap enough to run at message_end (before the
// tool calls execute) and on every bash tool_call (blocking gate).
// ---------------------------------------------------------------------------

/** Longest run / top frequency of ONE repeated word inside a payload. */
export interface DegenerateInfo {
	token: string;
	freq: number;
	maxRun: number;
	total: number;
}

export interface DegenerateHit extends DegenerateInfo {
	where: string;
}

/** Ignore 1-letter tokens as candidates (JSON keys like {"a":1} must not flag). */
const MIN_TOKEN_LEN = 2;

/**
 * Detect pathological single-word repetition in a payload (assistant text or a
 * JSON.stringify'd tool-call argument). Returns the repeated word with its
 * count, longest consecutive run and payload size, or undefined when the
 * payload is normal.
 *
 * Tokenization: runs of unicode letters, lowercased. Stored tool args are
 * JSON-escaped (real newlines arrived as the two characters `\n`), so escaped
 * whitespace is normalized back to a separator first — a word list written
 * across lines must still tokenize word by word. Digits/punctuation/code
 * symbols split tokens instead of polluting them.
 *
 * Signals (both are conclusive for generation quality):
 *   - a run of >= degenerateMaxRun consecutive identical words, or
 *   - one word occurring >= degenerateMaxFreq times with >= degenerateMaxShare
 *     of all tokens (catches interleaved "A B A B" meltdowns with no run).
 * A payload must have >= degenerateMinTokens tokens to be scanned.
 */
export function findDegenerateRepetition(
	text: string,
	config: AntiloopConfig,
): DegenerateInfo | undefined {
	let s = String(text).replace(/\\+[nrt]/g, " ").toLowerCase();
	const raw = s.match(/[\p{L}]+/gu);
	if (!raw) return undefined;
	const total = raw.length;

	let maxRun = 0;
	let runToken = "";
	let prev = "";
	let run = 0;
	const freq = new Map<string, number>();
	for (const t of raw) {
		if (t.length < MIN_TOKEN_LEN) {
			run = 0;
			prev = "";
			continue;
		}
		freq.set(t, (freq.get(t) ?? 0) + 1);
		if (t === prev) run++;
		else {
			run = 1;
			prev = t;
		}
		if (run > maxRun) {
			maxRun = run;
			runToken = t;
		}
	}
	let topToken = "";
	let topFreq = 0;
	for (const [t, c] of freq) {
		if (c > topFreq) {
			topFreq = c;
			topToken = t;
		}
	}
	if (total >= config.degenerateMinTokens) {
		if (maxRun >= config.degenerateMaxRun) {
			return { token: runToken, freq: freq.get(runToken) ?? topFreq, maxRun, total };
		}
		if (topFreq >= config.degenerateMaxFreq && topFreq / total >= config.degenerateMaxShare) {
			return { token: topToken, freq: topFreq, maxRun, total };
		}
	}

	// No-space meltdown: one giant periodic token ("noguerolnoguerol…" with all
	// separators stripped) is a perfect power of a short motif. Independent of
	// the token-count gate: a single 1200+ char token has no word runs at all.
	if (raw.length <= 2) {
		const single = raw.join("");
		const len = single.length;
		if (len >= 1200) {
			for (let p = 3; p <= 200 && p * 12 <= len; p++) {
				if (len % p) continue;
				const motif = single.slice(0, p);
				let ok = true;
				for (let i = p; i < len; i += p) {
					if (!single.startsWith(motif, i)) {
						ok = false;
						break;
					}
				}
				if (ok) {
					const repeats = len / p;
					if (repeats >= 12) {
						return { token: motif.slice(0, 40), freq: repeats, maxRun: repeats, total: repeats };
					}
				}
			}
		}
	}
	return undefined;
}

/** Scan one assistant message (text + each tool-call argument) for a meltdown. */
export function scanMessageDegenerate(
	content: string,
	toolCalls: TrackedToolCall[] | undefined,
	config: AntiloopConfig,
): DegenerateHit | undefined {
	if (!config.detectDegenerate) return undefined;
	if (content && content.length) {
		const d = findDegenerateRepetition(content, config);
		if (d) return { ...d, where: "message text" };
	}
	for (const tc of toolCalls ?? []) {
		if (!tc.args) continue;
		const d = findDegenerateRepetition(tc.args, config);
		if (d) return { ...d, where: tc.name === "bash" ? "bash command" : `args(${tc.name})` };
	}
	return undefined;
}

export function degenerateDescription(hit: DegenerateHit): string {
	const share = hit.total ? Math.round((hit.freq / hit.total) * 100) : 100;
	return `${hit.where}: degenerate repetition — "${hit.token}" ×${hit.freq} (${share}% of ${hit.total} tokens, longest run ${hit.maxRun})`;
}

/** Consecutive-detection weight of a detection turn. The strong
 * self-contained signals (degenerate meltdown, proven no-progress outcome run)
 * add degenerateTurnWeight (default 2) points so the FIRST one already reaches
 * the warning level and escalation is fast on repeat. */
export function detectionTurnWeight(detections: LoopDetection[], config: AntiloopConfig): number {
	const strong = detections.some((d) => d.type === "degenerate" || d.type === "outcome");
	return strong ? Math.max(1, config.degenerateTurnWeight) : 1;
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
	parts: unknown,
	isError: boolean,
): string | undefined {
	let text = "";
	if (typeof parts === "string") {
		text = parts;
	} else if (Array.isArray(parts)) {
		for (const p of parts) {
			if (p && typeof p === "object" && "type" in p && p.type === "text" && typeof (p as any).text === "string") {
				text += (p as any).text;
			}
		}
	}
	const norm = normalizeText(text);
	if (!norm.length) return undefined;
	// A tool run can FAIL while isError stays false (the NFS mount errors: the
	// ssh pipeline exits 0 after grep/echo, rc=32 lives inside the output). The
	// tail-only fingerprint would cut the failure markers away AND the tail is
	// noisy (journalctl timestamps differ per attempt), so for failures we keep
	// a SHORT ERROR SIGNATURE around the first failure marker — it repeats
	// verbatim across attempts of the same failure and makes same-outcome
	// comparisons robust. Formats: "err|…" / "ok|fail|sig|…|tail" / "ok|…".
	const failed = FAIL_MARKERS.test(norm);
	if (!failed) return `${isError ? "err" : "ok"}|${norm.slice(-400)}`;
	const at = norm.search(FAIL_MARKERS);
	const sig = norm.slice(Math.max(0, at - 60), at + 160);
	return `${isError ? "err" : "ok"}|fail|${sig}|${norm.slice(-400)}`;
}

/** Same outcome = identical fingerprint, or high similarity of the tails. */
function sameOutcome(a: string, b: string, threshold: number): boolean {
	if (a === b) return true;
	if (a.length < 100 && b.length < 100) {
		const max = Math.max(a.length, b.length);
		const s = max ? 1 - levenshtein(a, b) / max : 1;
		return s >= threshold;
	}
	const s = similarity(a, b);
	return s >= threshold && s > 0;
}

// Failure markers on a NORMALIZED fingerprint tail (lowercased, punctuation
// stripped — "rc=32" arrives as "rc32"). A conservative "this attempt failed"
// test: rc ≠ 0, denials, missing files, refusals, syntax crashes… Generic
// words like "error"/"failed" are intentionally NOT markers (legit outputs
// like "0 failed, 12 passed" must not count as failures).
const FAIL_MARKERS =
	/\b(denied|no such file|not found|cannot|unable|refused|syntax error|timed out|timeout|exception|traceback|fatal|core dumped|rc\s*[1-9]\d*)\b/i;

/** True when a captured result fingerprint represents a FAILED attempt.
 * Used by the no-progress outcome detector so only repeated FAILURES (not
 * repeated identical successes, which are the norm for task-stream batches
 * like "logged" or file writes) count as a stuck loop. */
export function isFailResult(fp: string | undefined): boolean {
	if (!fp) return false;
	if (fp.startsWith("err|") || fp.startsWith("ok|fail|")) return true;
	return FAIL_MARKERS.test(fp);
}

/** The short error signature embedded in a failure fingerprint
 * ("ok|fail|SIG|tail"), if present. */
function failSig(fp: string): string | undefined {
	const m = /^(?:err|ok)\|fail\|(.*?)\|/.exec(fp);
	return m ? m[1] : undefined;
}

/** Same-FAILURE comparison for the outcome detector. Prefers the embedded error
 * signatures (they repeat across attempts of the same failure) with digits
 * stripped — timestamps, PIDs and rc values are noise; the target words that
 * legitimately vary between attempts (Javi vs Compartido) survive but the
 * threshold is looser than the veto threshold on purpose. Falls back to the
 * full fingerprints when no signature is present. */
function sameFailure(a: string, b: string, threshold: number): boolean {
	const sa = failSig(a);
	const sb = failSig(b);
	if (sa && sb) return sameOutcome(sa.replace(/\d+/g, ""), sb.replace(/\d+/g, ""), threshold);
	return sameOutcome(a, b, threshold);
}

function toolCallsSimilar(
	c1: TrackedToolCall[],
	c2: TrackedToolCall[],
	threshold: number,
	resultThreshold: number,
): boolean {
	if (c1.length !== c2.length) return false;
	if (!c1.length) return false;
	for (let i = 0; i < c1.length; i++) {
		if (c1[i].name !== c2[i].name) return false;
		if (!argsTwin(c1[i].args, c2[i].args, threshold)) return false;
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
	if (msgs.length < 1) return out;
	const start = Math.max(0, msgs.length - config.detectionWindow);
	const win = msgs.slice(start);
	const now = Date.now();

	// Intra-message degenerate repetition fires on a SINGLE pathological message
	// (no peer needed) and is independent of the task-stream batch gate: a
	// meltdown is a meltdown even mid-batch.
	if (config.detectDegenerate) {
		const last = win[win.length - 1];
		const hit = scanMessageDegenerate(last.content, last.toolCalls, config);
		if (hit) {
			out.push({
				type: "degenerate",
				similarity: 1,
				messageIndices: [msgs.length - 1],
				description: degenerateDescription(hit),
				timestamp: now,
			});
		}
	}

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
					if (argsTwin(last, opens[i].o, 0.9)) n++;
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

	// -------------------------------------------------------------------
	// No-progress outcome runs (v1.6.1).
	//
	// The NFS-test session (/home/j 2026-09-09, rows 95–249): ~90 mutated
	// re-runs of the SAME experiment (sshpass+sudo+exportfs+mount, labels
	// "test A"…"test QQQ"), every one failing identically (rc=32 / access
	// denied). The tool-loop detector is blind to it BY DESIGN: args mutate
	// every turn (mean adjacent trigram similarity 0.93, but the label always
	// changes) so the same call never recurs >= minToolRepeatCount times, and
	// identical results only VETO tool loops — nothing uses "same outcome
	// repeated" as a positive signal. A human sees it instantly: many attempts,
	// same wall, zero progress.
	//
	// Signal: the LAST turn's single tool call has a captured result, and at
	// least outcomeMinRepeats PRIOR single-call turns (after the last real user
	// message — an autonomous stretch, not user-steered iteration) share BOTH
	// args >= outcomeArgSimilarity (the same experiment reshuffled) AND the same
	// outcome (>= resultSimilarityThreshold). Legit work is untouched: distinct
	// operations fail with distinct output; converging sweeps change outcome;
	// batch/stream messages are excluded; a success interspersed resets the
	// class. similarity 0.99 => after a force break, further same-outcome turns
	// count as "ignoring the break" (isVerbatimRepeat) and escalate to the hard
	// stop, exactly like verbatim tool loops.
	// -------------------------------------------------------------------
	if (config.detectOutcomeLoops) {
		const last = win[win.length - 1];
		const lastCalls = last.toolCalls;
		const afterUser = state.lastUserMessageTime;
		if (lastCalls && lastCalls.length === 1) {
			const lc = lastCalls[0];
			// Failure gate: only repeated FAILURES prove no progress. Task-stream
			// batches (punched_log appends, obsidian/file writes) legitimately
			// produce the SAME OK outcome every call — they must never count. And
			// batch messages must NOT be skipped here: a "bash ×N stream" with
			// identical failures is exactly the no-progress loop to catch.
			if (lc.result && isFailResult(lc.result)) {
				let matches = 0;
				for (let i = 0; i < win.length - 1; i++) {
					const m = win[i];
					if (m.timestamp <= afterUser) continue; // user-steered turns don't count
					const prev = m.toolCalls;
					if (!prev || prev.length !== 1) continue;
					const pc = prev[0];
					if (pc.name !== lc.name || !pc.result) continue;
					if (!sameFailure(lc.result, pc.result, config.outcomeSigThreshold)) continue;
					if (!argsTwin(lc.args, pc.args, config.outcomeArgSimilarity)) continue;
					matches++;
				}
				if (matches >= config.outcomeMinRepeats) {
					out.push({
						type: "outcome",
						similarity: 0.99,
						messageIndices: [msgs.length - 1],
						description:
							`no progress: ${matches + 1} near-identical ${lc.name} attempts (args ≥ ${(config.outcomeArgSimilarity * 100).toFixed(0)}% similar) with the same failing outcome — “${lc.result.slice(0, 90)}”`,
						timestamp: now,
					});
				}
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

/** Escalation level for a consecutive-detection count (mirror of the configured
 * ladder). Abort (3) only when abortThreshold is enabled (> 0). */
export function nextLevel(consecutiveDetections: number, config: AntiloopConfig): 0 | 1 | 2 | 3 {
	if (config.abortThreshold > 0 && consecutiveDetections >= config.abortThreshold) return 3;
	if (consecutiveDetections >= config.forceBreakThreshold) return 2;
	if (consecutiveDetections >= config.warningThreshold) return 1;
	return 0;
}

/** True when detections prove the model repeated a message/tool call essentially
 * verbatim (≥98% text similarity or an identical tool-loop), OR produced a
 * degenerate meltdown, OR kept re-running the same experiment with the same
 * failing outcome (no-progress, sim 0.99). Weaker signals (thinking echoes,
 * structural repeated openings at 90%) do NOT count — a model that only *thinks*
 * in circles but varies its actual output is still making an attempt and must
 * not be hard-stopped. Used post-force-break: only verbatim repeats and proven
 * no-progress repeats show the model ignored the break instruction. */
export function isVerbatimRepeat(detections: LoopDetection[]): boolean {
	return detections.some((d) => d.type !== "thinking" && d.similarity >= 0.98);
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
		enabled: true, warningThreshold: 2, forceBreakThreshold: 3, abortThreshold: 0, ignoredSteerLimit: 2,
		similarityThreshold: 0.75, toolSimilarityThreshold: 0.95, minToolRepeatCount: 2,
		resultSimilarityThreshold: 0.8, detectToolLoops: true, detectThinkingLoops: true,
		detectTextLoops: true, notifyOnDetection: true, maxHistoryEntries: 100,
		detectionWindow: 10, interactiveFooter: true, toggleShortcut: "esc+a",
		detectTaskStreams: true, taskStreamMinCalls: 3, taskStreamTwinThreshold: 0.99,
		detectDegenerate: true, degenerateMinTokens: 50, degenerateMaxRun: 16,
		degenerateMaxFreq: 60, degenerateMaxShare: 0.4, degenerateTurnWeight: 2, blockDegenerateBash: true,
		detectOutcomeLoops: true, outcomeMinRepeats: 8, outcomeArgSimilarity: 0.85, outcomeSigThreshold: 0.7,
	};
	const asState = (recentMessages: TrackedMessage[]): AntiloopState =>
		({ recentMessages, detections: [], activeTaskStreams: [], currentLevel: 0,
			consecutiveDetections: 0, inForcedBreak: false, totalDetections: 0,
			lastUserMessageTime: 0, lastDetectedTurnIndex: -1, turnSeq: 0,
			steerDelivered: false, ignoredSteerCount: 0 });
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

	// --- v1.5: escalation ladder + post-steer verbatim-repeat gating ---
	const lvl = (n: number) => nextLevel(n, tcfg);
	out.push(`ladder 0→0 1→0 2→1 3→2 4→2  → ${[0, 1, 2, 3, 4].map(lvl).join(",")} (exp 0,0,1,2,2) ${[0, 1, 2, 3, 4].map(lvl).join(",") === "0,0,1,2,2" ? "✅" : "❌"}`);
	const abortCfg: AntiloopConfig = { ...tcfg, abortThreshold: 5 };
	out.push(`ladder abort@5 → 5→3       → ${nextLevel(5, abortCfg)} (exp 3) ${nextLevel(5, abortCfg) === 3 ? "✅" : "❌"}`);
	const dl = (type: LoopDetection["type"], sim: number): LoopDetection[] =>
		[{ type, similarity: sim, messageIndices: [0, 1], description: `${type} ${sim}`, timestamp: Date.now() }];
	out.push(`verbatim text 1.00        → ${isVerbatimRepeat(dl("text", 1)) ? "yes" : "no"} (exp yes) ${isVerbatimRepeat(dl("text", 1)) ? "✅" : "❌"}`);
	out.push(`verbatim text 0.97        → ${isVerbatimRepeat(dl("text", 0.97)) ? "yes" : "no"} (exp no — changed output = attempt) ${!isVerbatimRepeat(dl("text", 0.97)) ? "✅" : "❌"}`);
	out.push(`verbatim tool-loop        → ${isVerbatimRepeat(dl("tool", 1)) ? "yes" : "no"} (exp yes) ${isVerbatimRepeat(dl("tool", 1)) ? "✅" : "❌"}`);
	out.push(`thinking-only 1.00        → ${isVerbatimRepeat(dl("thinking", 1)) ? "yes" : "no"} (exp no — output varies) ${!isVerbatimRepeat(dl("thinking", 1)) ? "✅" : "❌"}`);
	out.push(`structural 0.90           → ${isVerbatimRepeat(dl("structural", 0.9)) ? "yes" : "no"} (exp no) ${!isVerbatimRepeat(dl("structural", 0.9)) ? "✅" : "❌"}`);

	// --- v1.6: intra-message degenerate repetition (single-message meltdown) ---
	// Regression: the real session /home/j 2026-09-09T15-43 — ONE 46 KB bash call
	// whose username list repeats "noguerol" 5145 times (run of 5140). Every
	// cross-message detector needs a peer message and stayed silent; the
	// degenerate scan must fire on the FIRST such message, alone in the window.
	const argJson = (cmd: string) => JSON.stringify({ command: cmd }); // stored args form
	const meltdownCmd =
		`echo "=== brute usernames with petete pw ==="; for u in noguerol noguerol@ j javi javi@ root petete ${`noguerol `.repeat(400)}; do :; done`;
	const meltMsg = mk("", [{ name: "bash", args: argJson(meltdownCmd) }]);
	const mDet = detectLoops(asState([meltMsg]), tcfg);
	const mHit = mDet.find((d) => d.type === "degenerate");
	out.push(`degenerate first sight   → ${mHit ? `degenerate (${mHit.description})` : "no"} (exp degenerate — was the miss) ${mHit ? "✅" : "❌"}`);

	// Legit payloads must NOT flag: short commands are under minTokens, real
	// scripts never repeat one word 16× in a row.
	const leg1 = findDegenerateRepetition(sweepRun1, tcfg);
	const leg2 = findDegenerateRepetition("for i in 1 2 3; do echo step $i; done", tcfg);
	const leg3 = findDegenerateRepetition(
		"set -euo pipefail; mkdir -p build tmp dist logs data assets src test docs lib bin etc usr var opt srv && " +
			"cp -r config.yaml README.md LICENSE package.json tsconfig.json src lib test docs assets && " +
			"chmod +x scripts/deploy.sh scripts/backup.sh scripts/monitor.sh && " +
			"./scripts/deploy.sh --env production --region eu-west-1 --tag v1.2.3 --dry-run false > deploy.log 2>&1 || echo deploy failed",
		tcfg,
	);
	out.push(`degenerate legit cmd      → ${leg1 || leg2 || leg3 ? "flag" : "ok"} (exp ok) ${!leg1 && !leg2 && !leg3 ? "✅" : "❌"}`);

	// Interleaved meltdown ("A B A B…") has no long run — caught via freq/share.
	const inter = findDegenerateRepetition("noguerol petete ".repeat(150), tcfg);
	out.push(`degenerate interleaved    → ${inter ? `flag (${inter.token} ×${inter.freq})` : "no"} (exp flag — freq/share clause) ${inter ? "✅" : "❌"}`);

	// Word list written ACROSS lines: separators are the literal "\n" escapes
	// inside the stored JSON args — must still tokenize word by word.
	const acrossLines = argJson("for u in " + "noguerol\n".repeat(120) + "done");
	const linesHit = findDegenerateRepetition(acrossLines, tcfg);
	out.push(`degenerate across \n      → ${linesHit ? `flag (${linesHit.token} ×${linesHit.freq})` : "no"} (exp flag — escaped newlines) ${linesHit ? "✅" : "❌"}`);

	// No-space giant token ("noguerol" glued) — perfect-power clause.
	const glued = findDegenerateRepetition("noguerol".repeat(300), tcfg);
	out.push(`degenerate glued token    → ${glued ? `flag (${glued.token} ×${glued.freq})` : "no"} (exp flag — perfect power) ${glued ? "✅" : "❌"}`);

	// Turn weight: one degenerate turn = 2 consecutive points (warning on first
	// sight), normal turns stay at 1.
	const wDeg = detectionTurnWeight(mDet, tcfg);
	const wTxt = detectionTurnWeight(dl("text", 0.8), tcfg);
	out.push(`degenerate turn weight    → degenerate ${wDeg}, text ${wTxt} (exp 2, 1) ${wDeg === 2 && wTxt === 1 ? "✅" : "❌"}`);

	// --- v1.6.1: no-progress outcome runs (mutated re-runs, same outcome) ---
	// Regression: the NFS session — ~90 mutated re-runs of the SAME experiment
	// (ssh exportfs/mount, labels test A…test QQQ, targets alternating Javi /
	// Compartido), every one failing rc=32. Args mutate each turn (same call
	// never recurs → tool-loop silent) and journalctl noise varies per attempt,
	// but the FAILURE SIGNATURE repeats: that IS the loop. Fires on the 9th
	// attempt (8 prior same-failure matches ≥ outcomeMinRepeats).
	const nfsCmd = (label: string, target: string) =>
		argJson(
			`sshpass -p X ssh -o ConnectTimeout=10 noguerol@petete 'cd /tmp && echo X | sudo -S bash -c "echo --- test ${label}: rootdir=/volume2, absolute paths, fsid=0 and 1, mount /${target} ---; ` +
			`cat > /etc/exports << EOF\n/volume2/NAS-8TB-Javi *(rw,sync,no_subtree_check,fsid=0)\nEOF\nexportfs -ra\nsystemctl restart nfs-server\n` +
			`mount -t nfs4 -o vers=4.2 127.0.0.1:/${target} /tmp/nfstest 2>&1; echo rc=\$?; journalctl -u nfs-mountd | tail -4"' 2>&1`,
		);
	const nfsFailFor = (target: string, sec: number) =>
		resultFingerprint(
			[
				{
					type: "text",
					text:
						`--- mount /${target} --- | mount.nfs4: access denied by server while mounting 127.0.0.1:/${target} rc=32 | ` +
						`Sep 09 18:${sec} petete systemd[1]: Started nfs-mountd.service (PID ${1000 + sec})`,
				},
			],
			false,
		)!;
	const nfsOk = resultFingerprint([{ type: "text", text: "rc=0 | TARGET SOURCE FSTYPE | /tmp/nfstest 127.0.0.1:/  nfs4  rw,relatime" }], false)!;
	const targets = ["NAS-8TB-Javi", "NAS-8TB-Compartido"];
	const nfsMsgs = [..."ABCDEFGHI"].map((l, idx) =>
		mk("", [{ name: "bash", args: nfsCmd(l, targets[idx % 2]), result: nfsFailFor(targets[idx % 2], 100 + idx) }]),
	);
	const nfsDet = detectLoops(asState(nfsMsgs), tcfg);
	const nfsHit = nfsDet.find((d) => d.type === "outcome");
	out.push(`outcome fires on 9th      → ${nfsHit ? `outcome (${nfsHit.description.slice(0, 100)}…)` : nfsDet.map((d) => d.type).join(",") || "no"} (exp outcome — mixed targets) ${nfsHit ? "✅" : "❌"}`);
	out.push(`outcome weight            → ${detectionTurnWeight(nfsDet, tcfg)} (exp 2) ${detectionTurnWeight(nfsDet, tcfg) === 2 ? "✅" : "❌"}`);
	out.push(`outcome post-steer = ignored→ ${isVerbatimRepeat(nfsDet) ? "yes" : "no"} (exp yes — same failing outcome after the break) ${isVerbatimRepeat(nfsDet) ? "✅" : "❌"}`);

	// Below the repeat count: 5 identical-failure attempts → still trying, silent.
	const fewMsgs = [..."ABCDE"].map((l, idx) =>
		mk("", [{ name: "bash", args: nfsCmd(l, targets[idx % 2]), result: nfsFailFor(targets[idx % 2], 100 + idx) }]),
	);
	const fewDet = detectLoops(asState(fewMsgs), tcfg);
	out.push(`outcome needs 8 prior     → ${fewDet.some((d) => d.type === "outcome") ? "outcome" : "silent"} (exp silent at 5 attempts) ${!fewDet.some((d) => d.type === "outcome") ? "✅" : "❌"}`);

	// Converging sweep (v1.1 guarantee): similar args but the outcome CHANGES
	// (progress!) — must stay silent even with many attempts.
	const progMsgs = [..."ABCDEFGHIJ"].map((l, idx) =>
		mk("", [
			{
				name: "bash",
				args: nfsCmd(l, targets[idx % 2]),
				result:
					idx === 9
						? nfsOk
						: resultFingerprint(
								[{ type: "text", text: `attempt ${idx}: failed with rc=${idx + 30} reason=${idx % 3}` }],
								true,
						  )!,
			},
		]),
	);
	const progDet = detectLoops(asState(progMsgs), tcfg);
	out.push(`outcome converging sweep  → ${progDet.some((d) => d.type === "outcome") ? "outcome" : "silent"} (exp silent — outcomes differ = progress) ${!progDet.some((d) => d.type === "outcome") ? "✅" : "❌"}`);

	// Different FAILURE kinds with similar args (denied vs timeout vs no-such-file)
	// = evolving diagnosis, not the same wall — silent too.
	const diffFailMsgs = [..."ABCDEFGHIJ"].map((l, idx) => {
		const reasons = ["access denied by server", "timed out after 90 seconds", "No such file or directory"];
		const r = reasons[idx % 3];
		return mk("", [
			{ name: "bash", args: nfsCmd(l, targets[idx % 2]), result: resultFingerprint([{ type: "text", text: `mount failed: ${r} rc=32` }], false)! },
		]);
	});
	const diffFailDet = detectLoops(asState(diffFailMsgs), tcfg);
	out.push(`outcome diff failures     → ${diffFailDet.some((d) => d.type === "outcome") ? "outcome" : "silent"} (exp silent — error changed = progress) ${!diffFailDet.some((d) => d.type === "outcome") ? "✅" : "❌"}`);

	// Task-stream coexistence: a punched_log batch with identical tool results
	// must NOT count toward the outcome run (identical OK = normal batch).
	const batchFail = resultFingerprint([{ type: "text", text: "logged" }], false)!;
	const batchOutMsgs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => mk(NARR, [{ name: "punched_log", args: noteArgs(String(n)), result: batchFail }]));
	const batchOutDet = detectLoops(asState(batchOutMsgs), tcfg);
	out.push(`outcome batch excluded    → ${batchOutDet.some((d) => d.type === "outcome") ? "outcome" : "silent"} (exp silent — identical OKs are batch norm) ${!batchOutDet.some((d) => d.type === "outcome") ? "✅" : "❌"}`);

	// Failure gate: 9 near-identical attempts that all SUCCEED identically (e.g.
	// re-verifying a working setup, or a file-write batch) must stay silent —
	// only repeated FAILURES prove no progress.
	const okMsgs = [..."ABCDEFGHI"].map((l, idx) => mk("", [{ name: "bash", args: nfsCmd(l, targets[idx % 2]), result: nfsOk }]));
	const okDet = detectLoops(asState(okMsgs), tcfg);
	out.push(`outcome identical OKs     → ${okDet.some((d) => d.type === "outcome") ? "outcome" : "silent"} (exp silent — success repeats ≠ loop) ${!okDet.some((d) => d.type === "outcome") ? "✅" : "❌"}`);
	out.push(`isFailResult gate         → err| → ${isFailResult("err|boom") ? "fail" : "ok"}, rc32 → ${isFailResult("ok|rc32 denied") ? "fail" : "ok"}, rc0/ok → ${isFailResult("ok|rc 0 12 passed") ? "fail" : "ok"} (exp fail, fail, ok) ${isFailResult("err|boom") && isFailResult("ok|rc32 denied") && !isFailResult("ok|rc 0 12 passed") ? "✅" : "❌"}`);

	return out;
}
