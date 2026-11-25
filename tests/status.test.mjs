// antiloop — status / footer tests.
//
// Only the pi host boundary is stubbed; the real extension, config, command
// handlers and detectors are loaded. Two regressions are covered here:
//   * issue #1 — antiloop must never clear a footer it did not install
//     (@narumitw/pi-statusline disappears when setFooter(undefined) is called);
//   * PR #2 — `hideStatus` hides every indicator without disabling detection.
//
// Run with: node --test tests/*.test.mjs (Node 22.15+ / 24+).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "antiloop-test-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));

const hostModules = {
	"@earendil-works/pi-coding-agent": `
		export const getAgentDir = () => ${JSON.stringify(agentDir)};
		export const isToolCallEventType = (name, event) => event.toolName === name;
	`,
	"@earendil-works/pi-tui": "export const truncateToWidth = (text) => text;",
};
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier in hostModules) {
			return { url: `data:text/javascript,${encodeURIComponent(hostModules[specifier])}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const { default: extension } = await import("../src/index.ts");

const theme = { fg: (_color, text) => text };
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map(),
};

/** A footer owned by some other extension (pi-statusline, …). */
function otherExtensionFooter() {
	return () => ({ dispose() {}, invalidate() {}, render: () => ["other"] });
}

function makeApp() {
	const hooks = new Map();
	const statuses = new Map();
	const notifications = [];
	const steers = [];
	/** Every value handed to ctx.ui.setFooter — undefined included. */
	const footerCalls = [];
	let command;
	let component;
	let aborted = false;

	const ctx = {
		mode: "tui",
		cwd: "/tmp/project",
		signal: new AbortController().signal,
		model: { id: "test-model", contextWindow: 200_000 },
		isIdle: () => true,
		abort() {
			aborted = true;
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 0.1 }),
		ui: {
			theme,
			setStatus(key, value) {
				statuses.set(key, value);
			},
			// Mirrors pi: dispose the current custom footer, then install the new
			// one (or restore the built-in footer for undefined).
			setFooter(factory) {
				footerCalls.push(factory);
				component?.dispose?.();
				component = factory ? factory({ requestRender() {} }, theme, footerData) : undefined;
			},
			notify(...args) {
				notifications.push(args);
			},
			onTerminalInput() {
				return () => {};
			},
			async select(_title, items) {
				return items.find((item) => item.includes("hide status:"));
			},
		},
	};

	extension({
		on(name, handler) {
			hooks.set(name, handler);
		},
		registerCommand(_name, options) {
			command = options.handler;
		},
		sendUserMessage(...args) {
			steers.push(args);
		},
	});

	return {
		ctx,
		statuses,
		notifications,
		steers,
		footerCalls,
		get aborted() {
			return aborted;
		},
		emit: (name, event = {}) => hooks.get(name)(event, ctx),
		command: (args) => command(args, ctx),
	};
}

/**
 * Boot the extension with `config` persisted. `preFooter` is installed BEFORE
 * session_start, the way another extension's footer already is when antiloop
 * initializes.
 */
async function start(config, { preFooter } = {}) {
	writeFileSync(join(agentDir, "antiloop.json"), JSON.stringify(config));
	const app = makeApp();
	if (preFooter) app.ctx.ui.setFooter(preFooter);
	await app.emit("session_start");
	return app;
}

function persistedConfig() {
	return JSON.parse(readFileSync(join(agentDir, "antiloop.json"), "utf-8"));
}

test("default: the status line is visible and enable/disable updates it", async () => {
	const app = await start({});
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
	await app.command("disable");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:off");
	await app.command("enable");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
});

test("issue #1: a footer installed by another extension survives startup and shutdown", async () => {
	const other = otherExtensionFooter();
	const app = await start({}, { preFooter: other });
	// Default config (no interactive footer): antiloop must not call setFooter
	// at all, so the other extension's footer stays installed.
	assert.equal(app.footerCalls.length, 1);
	assert.equal(app.footerCalls.at(-1), other);

	await app.command("disable");
	await app.command("enable");
	await app.emit("turn_end");
	await app.emit("session_shutdown");
	assert.equal(app.footerCalls.at(-1), other);
	assert.equal(app.footerCalls.length, 1);
});

test("hidden status stays absent across lifecycle and commands without claiming a footer", async () => {
	for (const interactiveFooter of [false, true]) {
		const other = otherExtensionFooter();
		const app = await start({ hideStatus: true, interactiveFooter }, { preFooter: other });
		for (const cmd of ["disable", "enable", "reset"]) await app.command(cmd);
		await app.emit("turn_end");
		await app.emit("session_shutdown");
		assert.equal(app.statuses.get("antiloop"), undefined);
		// Only the pre-existing footer: antiloop never installed or cleared one.
		assert.equal(app.footerCalls.length, 1);
		assert.equal(app.footerCalls.at(-1), other);
	}
});

test("another extension's footer is not cleared after it replaces antiloop", async () => {
	const app = await start({ interactiveFooter: true });
	assert.equal(typeof app.footerCalls.at(-1), "function");

	const other = otherExtensionFooter();
	app.ctx.ui.setFooter(other);
	await app.command("config"); // toggles hide status on
	await app.emit("session_shutdown");
	assert.equal(app.footerCalls.at(-1), other);
});

test("hide/show commands toggle and persist a hidden status", async () => {
	const app = await start({});
	await app.command("hide");
	assert.equal(app.statuses.get("antiloop"), undefined);
	assert.equal(persistedConfig().hideStatus, true);

	await app.command("show");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
	assert.equal(persistedConfig().hideStatus, false);
});

test("session_start re-reads the persisted hidden status", async () => {
	const app = await start({ hideStatus: true });
	assert.equal(app.statuses.get("antiloop"), undefined);

	writeFileSync(join(agentDir, "antiloop.json"), JSON.stringify({ hideStatus: false }));
	await app.emit("session_start");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
});

test("hiding status leaves warning, force break, abort and bash blocking active", async () => {
	const app = await start({ hideStatus: true }, { preFooter: otherExtensionFooter() });
	const text = "lorem ".repeat(200);
	const message = { message: { role: "assistant", content: text } };

	await app.emit("message_end", message);
	assert.ok(app.notifications.some(([, level]) => level === "warning"), "warning still fires");

	await app.emit("message_end", message);
	assert.equal(app.steers.length, 1, "force break is still steered");

	await app.emit("message_end", message);
	await app.emit("message_end", message);
	assert.equal(app.aborted, true, "ignored break still aborts the run");

	const blocked = await app.emit("tool_call", { toolName: "bash", input: { command: text } });
	assert.equal(blocked.block, true, "degenerate bash is still blocked");
	assert.equal(app.statuses.get("antiloop"), undefined);
});

test("the status line carries the live level once a loop is detected", async () => {
	const app = await start({});
	await app.emit("message_end", { message: { role: "assistant", content: "lorem ".repeat(200) } });
	assert.match(app.statuses.get("antiloop"), /^🔄 a:on ⚠️/);
});

test("config menu hides and restores both indicators and persists the choice", async () => {
	const app = await start({ interactiveFooter: true });
	assert.equal(typeof app.footerCalls.at(-1), "function");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");

	await app.command("config"); // → hide status: on
	assert.equal(app.statuses.get("antiloop"), undefined);
	assert.equal(app.footerCalls.at(-1), undefined);
	assert.equal(persistedConfig().hideStatus, true);

	await app.emit("session_start");
	assert.equal(app.statuses.get("antiloop"), undefined);

	await app.command("config"); // → hide status: off
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
	assert.equal(typeof app.footerCalls.at(-1), "function");
	assert.equal(persistedConfig().hideStatus, false);
});
