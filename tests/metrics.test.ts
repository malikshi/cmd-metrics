// metrics.test.ts — unit tests for the mod's formatters, aggregates, render paths and persistence.
//
// exports: none
// used_by: none
// rules:   Date.now is frozen to a controllable clock; a harness sharing one store Map simulates a reload or restart. Assertions check rendered text, never internal state.
// agent:   claude-sonnet-4 | anthropic | 2026-11-02 | code-review | added boundary and resilience regressions, dropped dead helpers, added the L1 header
import {test} from 'node:test';
import assert from 'node:assert/strict';

const {
	default: mod,
	tpsText,
	formatDuration,
	formatTokens,
	formatRate,
	formatPercent,
	cachePercent,
	parseUsageBlock,
	modelLabel,
	sessionAverages,
} = await import('../status-metrics.ts');

function createHarness(
	sharedStore?: Map<string, unknown>,
	options: {failWrites?: boolean; omitCapabilities?: boolean} = {},
) {
	const handlers = new Map<string, Array<(event: any) => void>>();
	const overrides = new Map<string, (props: any, next?: () => any) => any>();
	const panes = new Map<string, any>();
	const widgets: Array<{placement: string; render: () => any[]}> = [];
	const commands = new Map<string, any>();
	const notices: string[] = [];
	// Stands in for the on-disk store file.
	// Rules:   passing the same Map to a second harness simulates a reload — new module memory, same file.
	const store = sharedStore ?? new Map<string, unknown>();
	let storeInFlight = 0;
	let storeOverlaps = 0;
	// Per-harness, so one test's pane open cannot leak into the next.
	let openedPane: string | undefined;
	// Every value handed to set(), so a test can check what a queued write actually captured.
	const writes: Array<{key: string; value: any}> = [];

	const cmd: any = {
		on: (type: string, handler: (event: any) => void) => {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
			return {dispose() {}};
		},
		hooks: (hooks: any) => {
			(createHarness as any).hooks = hooks;
			return {dispose() {}};
		},
		addCommand: (command: any) => {
			commands.set(command.name, command);
			return {dispose() {}};
		},
		ui: {
			// Rules:   an old host has no capabilities property at all; omitCapabilities models that.
			...(options.omitCapabilities
				? {}
				: {capabilities: {surface: true, status: true}}),
			override: (component: string, render: any) => {
				overrides.set(component, render);
				return {dispose() {}};
			},
			pane: (pane: any) => {
				panes.set(pane.id, pane);
				return {dispose() {}};
			},
			openPane: (id: string) => {
				openedPane = id;
			},
			widget: (widget: any) => {
				widgets.push(widget);
				return {dispose() {}};
			},
			closePane: () => {},
			notify: (message: string) => notices.push(message),
			refreshWidgets: () => {},
		},
		state: (() => {
			const values = new Map<string, unknown>();
			return {
				get: (key: string) => values.get(key),
				set: (key: string, value: unknown) => {
					values.set(key, value);
				},
			};
		})(),
		store: {
			get: (key: string) => store.get(key),
			// Rules:   each set is a whole-file read-modify-write that yields before landing, so overlapping writes would interleave; storeOverlaps counts them.
			set: async (key: string, value: unknown) => {
				if (options.failWrites) throw new Error('store unavailable');
				writes.push({key, value});
				if (storeInFlight > 0) storeOverlaps += 1;
				storeInFlight += 1;
				await new Promise(resolve => setTimeout(resolve, 0));
				store.set(key, value);
				storeInFlight -= 1;
			},
			delete: async (key: string) => {
				if (options.failWrites) throw new Error('store unavailable');
				if (storeInFlight > 0) storeOverlaps += 1;
				storeInFlight += 1;
				await new Promise(resolve => setTimeout(resolve, 0));
				store.delete(key);
				storeInFlight -= 1;
			},
		},
	};

	mod(cmd);

	return {
		emit(type: string, event: any = {type}) {
			for (const handler of handlers.get(type) ?? []) handler({type, ...event});
		},
		spinner(tokens = 0) {
			const render = overrides.get('spinner')!;
			return render({status: 'working', elapsedMs: 0, tokens}, undefined) ?? [];
		},
		pane(id = 'metrics') {
			return panes.get(id)!.render({width: 80});
		},
		command(name = 'metrics') {
			return commands.get(name)!.handler({args: '', ui: cmd.ui, cwd: '/tmp', exec: async () => ({stdout: '', stderr: '', code: 0})});
		},
		notices,
		widget(placement = 'below-editor') {
			const widget = widgets.find(entry => entry.placement === placement);
			return widget ? widget.render() : [];
		},
		get storeOverlaps() {
			return storeOverlaps;
		},
		openedPane: () => openedPane,
		setSurface: (surface: boolean) => {
			cmd.ui.capabilities = {surface, status: true};
		},
		writes,
		hooks: () => (createHarness as any).hooks,
	};
}

const flat = (nodes: any[]): string =>
	nodes
		.map(node => (node.children ? flat(node.children) : (node.text ?? '')))
		.join(' | ');

// Drain the queued store writes before asserting on the store.
// Rules:   each hop yields, so run every pending microtask and timer callback. The chain is
// serialized and each write awaits per key, so a burst of writes needs many hops to fully land —
// a frozen snapshot makes an under-drained chain visible (the file keeps an earlier write).
const flushWrites = async (): Promise<void> => {
	for (let index = 0; index < 80; index += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
};

let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;
const advance = (ms: number) => {
	clock += ms;
};

test.after(() => {
	Date.now = realNow;
});

test('tpsText formats TPS label', () => {
	assert.equal(tpsText(12.4), 'TPS 12');
	assert.equal(tpsText(3.14), 'TPS 3.1');
});

test('formatDuration, formatTokens and formatRate', () => {
	assert.equal(formatDuration(420), '0.42s');
	assert.equal(formatDuration(2_340), '2.3s');
	assert.equal(formatDuration(61_000), '1m01s');
	assert.equal(formatTokens(999), '999');
	assert.equal(formatTokens(12_345), '12k');
	assert.equal(formatTokens(1_500_000), '1.5M');
	assert.equal(formatRate(undefined), '—');
	assert.equal(formatRate(9.04), '9 t/s');
	assert.equal(formatRate(24.6), '25 t/s');
	assert.equal(formatRate(2_400), '2.4k t/s');
});

test('modelLabel keeps the tail of a routed model id', () => {
	assert.equal(modelLabel('nexrouter/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
	assert.equal(modelLabel('claude-sonnet-4'), 'claude-sonnet-4');
});

test('parseUsageBlock reads the sub-agent usage block', () => {
	const text = 'All done.\n\n<usage>total_tokens: 20370\ntool_uses: 1\nturns: 2\nduration_ms: 1234</usage>';
	assert.deepEqual(parseUsageBlock(text), {
		durationMs: 1234,
		totalTokens: 20_370,
		turns: 2,
		toolUses: 1,
	});
	assert.deepEqual(parseUsageBlock('no usage here'), {});
});

test('spinner shows live TPS, TTFT and elapsed for the active request', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'nexrouter/deepseek-v4.1-flash'});

	advance(400);
	h.emit('thinking_delta', {delta: 'think'});
	assert.equal(flat(h.spinner(0)), 'TTFT 0.40s | 0.40s');

	advance(800);
	const nodes = h.spinner(50);
	assert.match(flat(nodes), /TPS \d/);

	advance(100);
	h.emit('text_delta', {delta: 'hi'});
	const text = flat(h.spinner(120));
	assert.match(text, /TPS/);
	assert.match(text, /TTFT 0\.40s/);
	assert.match(text, /1\.3s$/);
});

test('model_request_end records TTFT, duration, tokens and TPS', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'nexrouter/deepseek-v4.1-flash'});
	advance(400);
	h.emit('text_delta', {delta: 'a'});
	advance(600);
	h.emit('model_request_end', {
		model: 'nexrouter/deepseek-v4.1-flash',
		usage: {inputTokens: 100, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0},
		stopReason: 'end_turn',
	});

	const paneText = flat(h.pane());
	assert.match(paneText, /#1/);
	assert.match(paneText, /deepseek-v4\.1-flash/);
	assert.match(paneText, /TTFT 0\.40s/);
	assert.match(paneText, /⏱ 1\.0s/);
	assert.match(paneText, /90 tok/);
	assert.match(paneText, /150 t\/s/);
	assert.match(paneText, /end_turn/);
});

test('a flush-at-end route reports a wall-clock rate, not a fantasy one', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/flush'});
	advance(2_000);
	h.emit('text_delta', {delta: 'whole answer'});
	h.emit('text_delta', {delta: ' more'});
	advance(3);
	// 500 tokens landed 3 ms after the only text: dividing by that span would report ~167k t/s.
	h.emit('model_request_end', {usage: {outputTokens: 500}, stopReason: 'end_turn'});

	const text = flat(h.pane());
	assert.match(text, /~250 t\/s/);
	assert.doesNotMatch(text, /k t\/s/);
});

test('a flush 200ms before the end is still caught by the rate, not by shape', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/late'});
	advance(2_000);
	h.emit('text_delta', {delta: 'a'});
	h.emit('text_delta', {delta: 'b'});
	advance(200);
	// A 200 ms generation span for 500 tokens implies 2.5k t/s — impossible, so wall clock wins.
	h.emit('model_request_end', {usage: {outputTokens: 500}, stopReason: 'end_turn'});

	const text = flat(h.pane());
	assert.match(text, /~227 t\/s/);
	assert.doesNotMatch(text, /2\.5k/);
});

test('a thinking chunk before a flushed answer stays bounded, never k-scale', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/reason'});
	advance(300);
	h.emit('thinking_delta', {delta: 'pondering'});
	advance(900);
	h.emit('text_delta', {delta: 'the whole answer'});
	advance(5);
	// Reasoning is billed as output, so the span from the thinking token is a real timeline and
	// 400 tokens over 905 ms is a plausible 442 t/s. What must never happen is a k-scale figure
	// from dividing by the 5 ms transport tail.
	h.emit('model_request_end', {usage: {outputTokens: 400}, stopReason: 'end_turn'});

	const text = flat(h.pane());
	assert.match(text, /442 t\/s/);
	assert.doesNotMatch(text, /\d+k t\/s/);
});

test('a short genuine stream keeps its measured rate instead of being downgraded', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/brief'});
	advance(2_000);
	h.emit('text_delta', {delta: 'Done.'});
	advance(200);
	h.emit('text_delta', {delta: ' Anything else?'});
	advance(20);
	// 6 tokens over a 220 ms generation span is a plausible 27 t/s: no downgrade, no `~`.
	h.emit('model_request_end', {usage: {outputTokens: 6}, stopReason: 'end_turn'});

	const text = flat(h.pane());
	assert.match(text, /27 t\/s/);
	assert.doesNotMatch(text, /~/);
});

test('an absurd wall-clock rate is dropped rather than published', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/instant'});
	h.emit('text_delta', {delta: 'x'});
	advance(5);
	// Even wall clock cannot make 500 tokens in 5 ms real; the row reports no rate at all.
	h.emit('model_request_end', {usage: {outputTokens: 500}, stopReason: 'end_turn'});

	// The header mentions t/s, so assert on a rendered rate, not on the word.
	const text = flat(h.pane());
	assert.doesNotMatch(text, /\d+(\.\d+)?\s?[kM]? t\/s\b(?! =)/);
	assert.doesNotMatch(text, /~—/);
});

test('a normally streamed request still divides by generation time', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/stream'});
	advance(400);
	for (let index = 0; index < 5; index += 1) {
		advance(120);
		h.emit('text_delta', {delta: 'chunk'});
	}
	advance(100);
	h.emit('model_request_end', {usage: {outputTokens: 100}, stopReason: 'end_turn'});

	const text = flat(h.pane());
	// TTFT 0.52s, duration 1.1s → 100 tokens over 0.58s of generation.
	assert.match(text, /172 t\/s/);
	assert.doesNotMatch(text, /~/);
});

test('spinner falls back to the last completed request between requests', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(250);
	h.emit('text_delta', {delta: 'x'});
	advance(750);
	h.emit('model_request_end', {usage: {outputTokens: 40}, stopReason: 'end_turn'});

	const text = flat(h.spinner(0));
	assert.match(text, /⏱ 1\.0s · TTFT 0\.25s/);
	assert.match(text, /t\/s/);
});

test('each completed request gets its own row in order', () => {
	const h = createHarness();
	h.emit('run_start');
	for (const [index, model] of ['a/one', 'b/two', 'c/three'].entries()) {
		h.emit('model_request_start', {model});
		advance(100);
		h.emit('text_delta', {delta: 't'});
		advance(100);
		h.emit('model_request_end', {usage: {outputTokens: 10 + index}});
	}
	const text = flat(h.pane());
	assert.match(text, /#1 \| one/);
	assert.match(text, /#2 \| two/);
	assert.match(text, /#3 \| three/);
});

test('subagent TTFT is spawn to first child activity, and TPS excludes it', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {
		toolCallId: 'call_1',
		subagentType: 'explore',
		description: 'Find auth code',
	});
	advance(500);
	h.emit('subagent_progress', {toolCallId: 'call_1', tokensUsed: 1_200, toolName: 'grep'});
	const running = flat(h.pane());
	assert.match(running, /⑂explore/);
	assert.match(running, /Find auth code/);
	assert.match(running, /TTFT 0\.50s/);
	assert.match(running, /⏱ 0\.50s/);
	assert.match(running, /1 tool call/);

	advance(1_500);
	h.emit('subagent_stop', {toolCallId: 'call_1', tokensUsed: 20_370});
	const finished = flat(h.pane());
	assert.match(finished, /✓ \| ⑂explore/);
	assert.match(finished, /TTFT 0\.50s/);
	assert.match(finished, /⏱ 2\.0s/);
	assert.match(finished, /20k tok/);
	assert.match(finished, /13\.6k t\/s/);
});

test('running subagents appear on the spinner line', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'plan', description: 'Design'});
	advance(1_500);
	h.emit('subagent_start', {toolCallId: 'c2', subagentType: 'explore', description: 'Search'});
	advance(250);
	const text = flat(h.spinner(0));
	assert.match(text, /⑂plan 1\.8s/);
	assert.match(text, /⑂explore 0\.25s/);

	h.emit('subagent_stop', {toolCallId: 'c1', tokensUsed: 10});
	assert.doesNotMatch(flat(h.spinner(0)), /⑂plan/);
});

test('agent tool usage block refines the sub-agent duration and tokens', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c9', subagentType: 'general', description: 'work'});
	advance(100);
	h.emit('subagent_stop', {toolCallId: 'c9', tokensUsed: 10});
	h.emit('tool_completed', {
		toolCallId: 'c9',
		toolName: 'agent',
		result: [
			{
				type: 'text',
				text: '<usage>total_tokens: 20370\ntool_uses: 1\nturns: 2\nduration_ms: 3000</usage>',
			},
		],
	});
	const text = flat(h.pane());
	assert.match(text, /⏱ 3\.0s/);
	assert.match(text, /20k tok/);
	assert.match(text, /7\.0k t\/s/);
});

test('background sub-agent stop carries status', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'bg1', subagentType: 'general', description: 'bg'});
	advance(200);
	h.emit('subagent_stop', {toolCallId: 'bg1', tokensUsed: 0, status: 'completed'});
	assert.match(flat(h.pane()), /completed/);
});

test('a new run keeps the session aggregates and only clears live state', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'general', description: 'd'});
	assert.match(flat(h.pane()), /#1/);

	// A run is one prompt: the below-editor line must survive the next submit.
	h.emit('run_start');
	const text = flat(h.pane());
	assert.match(text, /#1/);
	assert.match(text, /⑂/);
	assert.match(flat(h.widget()), /session/);
});

test('/metrics opens the pane and reports a summary', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(200);
	h.emit('text_delta', {delta: 'x'});
	advance(200);
	h.emit('model_request_end', {usage: {outputTokens: 20}});

	const result = h.command();
	assert.equal(h.openedPane(), 'metrics');
	assert.match(result.message, /1 request/);
	assert.match(result.message, /avg .*t\/s/);
	assert.match(result.message, /avg TTFT 0\.20s/);
});

test('run_end notifies the summary', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	h.emit('run_end', {});
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /1 request/);
});

test('session hooks reset state', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	h.hooks().onSessionStart({source: 'startup'});
	assert.doesNotMatch(flat(h.pane()), /#1/);
});

test('a cancelled or failed request leaves no stale live state', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('run_end', {});
	h.emit('run_start');
	assert.doesNotMatch(flat(h.pane()), /▶/);
});

test('cachePercent is cache reads over total prompt tokens', () => {
	// inputTokens already counts cached tokens (the cost path subtracts them back out).
	assert.equal(Math.round(cachePercent({inputTokens: 27_947, outputTokens: 123, cacheReadTokens: 14_336})!), 51);
	assert.equal(cachePercent({inputTokens: 1_000, cacheReadTokens: 1_000}), 100);
	assert.equal(cachePercent({inputTokens: 1_000, cacheReadTokens: 0}), 0);
	assert.equal(cachePercent({inputTokens: 0, cacheReadTokens: 0}), undefined);
	assert.equal(cachePercent(undefined), undefined);
	assert.equal(cachePercent({inputTokens: 100, cacheReadTokens: 500}), 100);
});

test('formatPercent keeps a decimal only for small non-zero values', () => {
	assert.equal(formatPercent(undefined), '—');
	assert.equal(formatPercent(0), '0%');
	assert.equal(formatPercent(4.26), '4.3%');
	assert.equal(formatPercent(51.32), '51%');
	assert.equal(formatPercent(100), '100%');
});

test('a request row reports its cache percentage', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	advance(100);
	h.emit('model_request_end', {
		usage: {inputTokens: 20_000, outputTokens: 50, cacheReadTokens: 15_000, cacheWriteTokens: 0},
		stopReason: 'end_turn',
	});
	assert.match(flat(h.pane()), /cache 75%/);
	// Between requests the spinner carries the last request's hit rate too.
	assert.match(flat(h.spinner(0)), /cache 75%/);
});

test('session cache rate is token-weighted, not an average of percentages', () => {
	const h = createHarness();
	h.emit('run_start');
	// A tiny cold request and a huge warm one: averaging percentages would give ~50%,
	// the honest token-weighted rate is 9900/10100 = 98%.
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {inputTokens: 100, outputTokens: 5, cacheReadTokens: 0}});
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {inputTokens: 10_000, outputTokens: 5, cacheReadTokens: 9_900}});
	const message = h.command().message;
	assert.match(message, /cache 98%/);
	assert.doesNotMatch(message, /cache 50%/);
});

test('a request with no usage reports no cache figure', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0}});
	assert.match(flat(h.pane()), /cache —/);
});

test('sessionAverages averages TTFT, TPS and duration over requests', () => {
	const stats = sessionAverages([
		{ttftMs: 400, tps: 100, durationMs: 1_000, inputTokens: 1_000, outputTokens: 50},
		{ttftMs: 600, tps: 200, durationMs: 3_000, inputTokens: 3_000, outputTokens: 150},
	]);
	assert.equal(stats.avgTtftMs, 500);
	assert.equal(stats.avgTps, 150);
	assert.equal(stats.avgDurationMs, 2_000);
	// Token-weighted cache: 0/4000 read, and total tokens counts input + output.
	assert.equal(stats.cachePercent, 0);
	assert.equal(stats.totalTokens, 4_200);
	assert.equal(stats.requests, 2);
});

test('sessionAverages keeps sub-agent tokens out of the parent total', () => {
	const stats = sessionAverages(
		[{ttftMs: 400, tps: 100, durationMs: 1_000, inputTokens: 1_000, outputTokens: 50}],
		[{tokensUsed: 20_000}, {tokens: 5_000}],
	);
	assert.equal(stats.avgTtftMs, 400);
	assert.equal(stats.avgTps, 100);
	assert.equal(stats.totalTokens, 1_050);
	assert.equal(stats.subagentTotalTokens, 25_000);
	assert.equal(stats.subagents, 2);
});

test('sessionAverages reports no averages for an empty session', () => {
	const stats = sessionAverages([]);
	assert.equal(stats.avgTtftMs, undefined);
	assert.equal(stats.avgTps, undefined);
	assert.equal(stats.avgDurationMs, undefined);
	assert.equal(stats.cachePercent, undefined);
	assert.equal(stats.totalTokens, 0);
	assert.equal(stats.subagentTotalTokens, 0);
});

test('sessionAverages reports sub-agent averages in their own fields', () => {
	const stats = sessionAverages(
		[{ttftMs: 400, tps: 100, durationMs: 1_000, inputTokens: 1_000, outputTokens: 50}],
		[
			{ttftMs: 500, tps: 200, durationMs: 2_000, tokensUsed: 1_000, toolCalls: 2},
			{ttftMs: 1_500, tps: 400, durationMs: 4_000, tokensUsed: 3_000, toolCalls: 4},
		],
	);
	assert.equal(stats.subagentAvgTtftMs, 1_000);
	assert.equal(stats.subagentAvgTps, 300);
	assert.equal(stats.subagentAvgDurationMs, 3_000);
	assert.equal(stats.subagentTotalTokens, 4_000);
	assert.equal(stats.subagentToolCalls, 3);
	// The parent averages are untouched by the children.
	assert.equal(stats.avgTtftMs, 400);
	assert.equal(stats.avgTps, 100);
	assert.equal(stats.avgDurationMs, 1_000);
});

test('sub-agent averages skip records that never produced a figure', () => {
	const stats = sessionAverages([], [{tokens: 500}, {tokensUsed: 1_500, durationMs: 2_000}]);
	// Only the finalised record contributes a duration; neither carries a rate.
	assert.equal(stats.subagentAvgDurationMs, 2_000);
	assert.equal(stats.subagentAvgTtftMs, undefined);
	assert.equal(stats.subagentAvgTps, undefined);
	// Every child's own token count still sums into the child total.
	assert.equal(stats.subagentTotalTokens, 2_000);
});

test('sub-agent averages survive a reload, since the records are stored', async () => {
	const store = new Map<string, unknown>();
	const first = createHarness(store);
	first.hooks().onSessionStart({source: 'startup', sessionId: 'sess-sub'});
	first.emit('run_start');
	first.emit('subagent_start', {toolCallId: 'c1', subagentType: 'explore', description: 'find'});
	advance(500);
	first.emit('subagent_progress', {toolCallId: 'c1', tokensUsed: 1_000});
	advance(1_500);
	first.emit('subagent_stop', {toolCallId: 'c1', tokensUsed: 20_370});
	await flushWrites();

	const reloaded = createHarness(store);
	reloaded.hooks().onSessionStart({source: 'reload', sessionId: 'sess-sub'});
	const text = flat(reloaded.widget());
	assert.match(text, /⑂1/);
	assert.match(text, /TTFT 0\.50s/);
	assert.match(text, /20k tok/);
});

test('the widget gives sub-agent averages their own line', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(400);
	h.emit('text_delta', {delta: 'x'});
	advance(600);
	h.emit('model_request_end', {usage: {inputTokens: 1_000, outputTokens: 60}});
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'explore', description: 'find'});
	advance(300);
	h.emit('subagent_progress', {toolCallId: 'c1', tokensUsed: 100});
	advance(700);
	h.emit('subagent_stop', {toolCallId: 'c1', tokensUsed: 900});

	const lines = h.widget();
	assert.equal(lines.length, 2);
	// Parent row stays measured; the child row is separate and labelled.
	assert.match(flat([lines[0]]), /^session \| TTFT/);
	assert.match(flat([lines[1]]), /⑂1 \| TTFT 0\.30s \| /);
	// The parent token total is requests only — the child's 900 must not appear in it.
	assert.match(flat([lines[0]]), /1\.1k tok/);
	assert.match(flat([lines[1]]), /900 tok/);
});

test('below-editor widget shows session averages and total tokens', () => {
	const h = createHarness();
	assert.match(flat(h.widget()), /no requests yet/);
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(400);
	h.emit('text_delta', {delta: 'x'});
	advance(600);
	h.emit('model_request_end', {
		usage: {inputTokens: 1_000, outputTokens: 60, cacheReadTokens: 700},
	});
	const text = flat(h.widget());
	assert.match(text, /TTFT 0\.40s/);
	assert.match(text, /100 t\/s/);
	assert.match(text, /⏱ 1\.0s/);
	assert.match(text, /cache 70%/);
	assert.match(text, /1\.1k tok/);
});

test('/metrics summary reports average duration and total tokens', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(400);
	h.emit('text_delta', {delta: 'x'});
	advance(600);
	h.emit('model_request_end', {usage: {inputTokens: 1_000, outputTokens: 60}});
	const message = h.command().message;
	assert.match(message, /avg TTFT 0\.40s/);
	assert.match(message, /avg duration 1\.0s/);
	assert.match(message, /total 1\.1k tok/);
});

test('formatTokens rolls over at the k boundary instead of printing 1000k', () => {
	assert.equal(formatTokens(999_499), '999k');
	// Rules:   999,949 rounds inside k to 1000, so it rolls to 1.0M rather than read 1000k.
	assert.equal(formatTokens(999_949), '1.0M');
	assert.equal(formatTokens(999_999), '1.0M');
	assert.equal(formatTokens(1_000_000), '1.0M');
});

test('formatRate rounds before choosing the unit', () => {
	assert.equal(formatRate(999.7), '1.0k t/s');
	assert.equal(formatRate(999.4), '999 t/s');
	assert.equal(formatRate(1_000), '1.0k t/s');
});

test('formatDuration renders a missing duration as a dash', () => {
	assert.equal(formatDuration(undefined), '—');
	assert.equal(formatDuration(0), '0.00s');
});

test('a request that never streamed a token reports no TTFT and no TPS', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(2_000);
	// No thinking_delta / text_delta / message_update: the first token was never observed.
	h.emit('model_request_end', {usage: {inputTokens: 900, outputTokens: 0}});

	const paneText = flat(h.pane());
	// Rules:   duration is still real, but TTFT must never be the duration dressed up as a measurement.
	assert.match(paneText, /TTFT —/);
	assert.match(paneText, /⏱ 2\.0s/);

	const message = h.command().message;
	assert.doesNotMatch(message, /avg TTFT/);

	// And it must not enter the session TTFT average.
	h.emit('model_request_start', {model: 'm/two'});
	advance(300);
	h.emit('text_delta', {delta: 'x'});
	advance(200);
	h.emit('model_request_end', {usage: {outputTokens: 10}});
	assert.match(h.command().message, /avg TTFT 0\.30s/);
});

test('session averages stay session-wide past the pane display cap', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(1_000);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 10}});

	// 55 more fast requests. A trailing-50 window would keep only these and report 0.10s.
	for (let index = 0; index < 55; index += 1) {
		h.emit('model_request_start', {model: 'm/fast'});
		advance(100);
		h.emit('text_delta', {delta: 'x'});
		h.emit('model_request_end', {usage: {outputTokens: 10}});
	}

	// (1000 + 55 × 100) ÷ 56 = 6,500ms ÷ 56 = 116ms. A trailing-50 window of only the fast
	// requests would report 0.10s and 50 requests.
	assert.match(h.command().message, /56 request/);
	assert.match(h.command().message, /avg TTFT 0\.12s/);

	// The pane still caps its rows and numbers the survivors by true position.
	const paneText = flat(h.pane());
	assert.match(paneText, /… 6 earlier request/);
	assert.match(paneText, /#7 \| fast/);
	assert.doesNotMatch(paneText, /#1 \|/);
});

test('an agent tool result without a usage block does not close the child at zero', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'general', description: 'work'});
	advance(1_500);
	h.emit('tool_completed', {toolCallId: 'c1', toolName: 'agent', result: 'no usage here'});

	// Still running: the elapsed time stays live instead of freezing at 0.00s.
	const text = flat(h.pane());
	assert.match(text, /▶/);
	assert.match(text, /⏱ 1\.5s/);
});

test('an empty session keeps the widget line instead of dropping it', () => {
	const h = createHarness();
	assert.match(flat(h.widget()), /session \| no requests yet/);
});

test('a reload restores the figures from cmd.store for the same session', async () => {
	const store = new Map<string, unknown>();
	const first = createHarness(store);
	first.hooks().onSessionStart({source: 'startup', sessionId: 'sess-1'});
	first.emit('run_start');
	first.emit('model_request_start', {model: 'm/one'});
	advance(400);
	first.emit('text_delta', {delta: 'x'});
	advance(600);
	first.emit('model_request_end', {usage: {inputTokens: 1_000, outputTokens: 60}});

	// A hot reload of the same session: the factory runs again with empty memory.
	await flushWrites();
	first.hooks().onSessionEnd({reason: 'reload'});
	await flushWrites();
	const reloaded = createHarness(store);
	reloaded.hooks().onSessionStart({source: 'reload', sessionId: 'sess-1'});

	assert.match(flat(reloaded.widget()), /TTFT 0\.40s/);
	assert.match(flat(reloaded.widget()), /1\.1k tok/);
	assert.match(flat(reloaded.pane()), /#1/);
	assert.match(reloaded.command().message, /1 request/);
});

test('a /reload restart restores figures because the session id matches', async () => {
	const store = new Map<string, unknown>();
	const before = createHarness(store);
	before.hooks().onSessionStart({source: 'startup', sessionId: 'sess-9'});
	before.emit('run_start');
	before.emit('model_request_start', {model: 'm/one'});
	advance(200);
	before.emit('text_delta', {delta: 'x'});
	advance(800);
	before.emit('model_request_end', {usage: {inputTokens: 2_000, outputTokens: 100}});

	// The process restarted: new module instance, same on-disk store, resumed session.
	await flushWrites();
	const after = createHarness(store);
	after.hooks().onSessionStart({source: 'startup', sessionId: 'sess-9'});

	assert.match(after.command().message, /1 request/);
	assert.match(flat(after.widget()), /2\.1k tok/);
});

test('a different session does not adopt the stored totals', () => {
	const store = new Map<string, unknown>();
	const first = createHarness(store);
	first.hooks().onSessionStart({source: 'startup', sessionId: 'sess-a'});
	first.emit('run_start');
	first.emit('model_request_start', {model: 'm/one'});
	advance(100);
	first.emit('text_delta', {delta: 'x'});
	first.emit('model_request_end', {usage: {outputTokens: 5}});

	const second = createHarness(store);
	second.hooks().onSessionStart({source: 'startup', sessionId: 'sess-b'});
	assert.match(second.command().message, /no completed model requests yet/);
	assert.match(flat(second.widget()), /no requests yet/);
});

test('resuming an older session restores that session, not the latest one', async () => {
	const store = new Map<string, unknown>();

	const older = createHarness(store);
	older.hooks().onSessionStart({source: 'startup', sessionId: 'sess-old'});
	older.emit('run_start');
	older.emit('model_request_start', {model: 'm/old'});
	advance(100);
	older.emit('text_delta', {delta: 'x'});
	older.emit('model_request_end', {usage: {inputTokens: 1_000, outputTokens: 10}});

	const newer = createHarness(store);
	newer.hooks().onSessionStart({source: 'startup', sessionId: 'sess-new'});
	newer.emit('run_start');
	newer.emit('model_request_start', {model: 'm/new'});
	advance(100);
	newer.emit('text_delta', {delta: 'x'});
	newer.emit('model_request_end', {usage: {inputTokens: 5_000, outputTokens: 90}});
	newer.emit('model_request_start', {model: 'm/new'});
	advance(100);
	newer.emit('text_delta', {delta: 'x'});
	newer.emit('model_request_end', {usage: {inputTokens: 5_000, outputTokens: 90}});

	// Resuming the OLDER session must bring back its single request, not the newer two.
	await flushWrites();
	const resumed = createHarness(store);
	resumed.hooks().onSessionStart({source: 'startup', sessionId: 'sess-old'});
	assert.match(resumed.command().message, /1 request/);
	assert.match(flat(resumed.pane()), /old/);
	assert.doesNotMatch(flat(resumed.pane()), /new/);
});

test('the stored session index drops the oldest entries rather than growing forever', async () => {
	const store = new Map<string, unknown>();
	for (let index = 0; index < 25; index += 1) {
		const h = createHarness(store);
		h.hooks().onSessionStart({source: 'startup', sessionId: `sess-${index}`});
		h.emit('run_start');
		h.emit('model_request_start', {model: 'm/one'});
		advance(100);
		h.emit('text_delta', {delta: 'x'});
		h.emit('model_request_end', {usage: {outputTokens: 5}});
		await flushWrites();
	}

	const index: string[] = store.get('sessions') as string[];
	assert.equal(index.length, 20);
	assert.equal(index[0], 'sess-24');
	// The evicted ones are gone from the file, not merely unlisted.
	assert.equal(store.has('session:sess-0'), false);
	assert.equal(store.has('session:sess-24'), true);
});

test('store writes never overlap, because the host rewrites the whole file', async () => {
	const store = new Map<string, unknown>();
	const h = createHarness(store);
	h.hooks().onSessionStart({source: 'startup', sessionId: 'sess-c'});

	// Several saves in the same tick, exactly how a burst of requests would land.
	h.emit('run_start');
	for (let index = 0; index < 5; index += 1) {
		h.emit('model_request_start', {model: 'm/one'});
		advance(100);
		h.emit('text_delta', {delta: 'x'});
		h.emit('model_request_end', {usage: {outputTokens: 5}});
		h.emit('subagent_start', {toolCallId: `c${index}`, subagentType: 'general', description: 'd'});
		h.emit('subagent_stop', {toolCallId: `c${index}`, tokensUsed: 5});
	}
	await flushWrites();

	assert.equal(h.storeOverlaps, 0);
	// And the last write wins with the full history, not a torn one.
	assert.equal((store.get('session:sess-c') as any).requests.length, 5);
});

test('sub-agents survive a reload with the session', async () => {
	const store = new Map<string, unknown>();
	const first = createHarness(store);
	first.hooks().onSessionStart({source: 'startup', sessionId: 'sess-s'});
	first.emit('run_start');
	first.emit('subagent_start', {toolCallId: 'c1', subagentType: 'explore', description: 'find'});
	advance(500);
	first.emit('subagent_progress', {toolCallId: 'c1', tokensUsed: 1_000});
	advance(500);
	first.emit('subagent_stop', {toolCallId: 'c1', tokensUsed: 20_370});

	await flushWrites();
	const reloaded = createHarness(store);
	reloaded.hooks().onSessionStart({source: 'reload', sessionId: 'sess-s'});
	const text = flat(reloaded.pane());
	assert.match(text, /⑂explore/);
	assert.match(text, /20k tok/);
	assert.match(reloaded.command().message, /1 sub-agent/);
});

test('formatTokens never prints a bare 1000 at the k boundary', () => {
	// 999.6 would round to 1000, which is neither "1.0k" nor a valid bare count.
	assert.equal(formatTokens(999.6), '1.0k');
	assert.equal(formatTokens(999.4), '999');
	// The k unit itself must not print a trailing ".0" past the 10k boundary.
	assert.equal(formatTokens(9_999), '10k');
	assert.equal(formatTokens(10_000), '10k');
});

test('formatPercent never prints 10.0% at the boundary', () => {
	// 9.96 rounds to 10.0, which must collapse to the same shape as an exact 10.
	assert.equal(formatPercent(9.96), '10%');
	assert.equal(formatPercent(9.99), '10%');
	assert.equal(formatPercent(10), '10%');
	assert.equal(formatPercent(9.94), '9.9%');
});

test('a wall-clock rate is excluded from the measured average', () => {
	// One measured 200 t/s request plus one flush whose wall-clock rate is 50 t/s.
	const stats = sessionAverages([
		{tps: 200, wallClockRate: false},
		{tps: 50, wallClockRate: true},
	]);
	// Mixing them would report 125 t/s, a figure neither request supports.
	assert.equal(stats.avgTps, 200);
	assert.equal(stats.wallClockRequests, 1);
});

test('session cache rate is clamped like the per-request rate', () => {
	// cacheReadTokens exceeding inputTokens is nonsense; the row clamps to 100, so must the aggregate.
	const stats = sessionAverages([{inputTokens: 1_000, cacheReadTokens: 2_000}]);
	assert.equal(stats.cachePercent, 100);
});

test('run_end without model_request_end drops the phantom live request', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(400);
	h.emit('text_delta', {delta: 'x'});
	advance(600);
	// The request is cancelled: no model_request_end ever arrives.
	h.emit('run_end', {});

	// No live row, and the spinner must not claim a running request forever.
	assert.doesNotMatch(flat(h.pane()), /▶/);
	assert.doesNotMatch(flat(h.spinner(0)), /TTFT 0\.40s/);
});

test('an aborted request is dropped when interrupted, not left running', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(400);
	h.emit('text_delta', {delta: 'x'});
	advance(600);
	// Ctrl-C mid-stream: the host emits interrupted, never model_request_end.
	h.emit('interrupted');

	assert.doesNotMatch(flat(h.pane()), /▶/);
	assert.doesNotMatch(flat(h.spinner(0)), /TTFT 0\.40s/);
	// No usage ever arrived, so there is nothing to record — and no phantom row either.
	assert.doesNotMatch(flat(h.pane()), /#1/);
	assert.match(h.command().message, /no completed model requests yet/);
});

test('an abort keeps the session history it already had', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/first'});
	advance(200);
	h.emit('text_delta', {delta: 'x'});
	advance(800);
	h.emit('model_request_end', {usage: {outputTokens: 20}});
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/second'});
	advance(300);
	h.emit('interrupted');

	// The completed request must not be erased by the abort of the next one.
	assert.match(h.command().message, /1 request/);
	assert.match(flat(h.pane()), /first/);
});

test('an abort closes the sub-agents it orphans instead of leaving them running', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'explore', description: 'find'});
	advance(500);
	h.emit('subagent_progress', {toolCallId: 'c1', tokensUsed: 1_000, toolName: 'grep'});
	advance(500);
	h.emit('interrupted');

	const text = flat(h.pane());
	assert.match(text, /✓/);
	assert.doesNotMatch(text, /▶/);
	assert.match(text, /interrupted/);
});

test('a non-retryable run_error also drops the live request', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(250);
	h.emit('text_delta', {delta: 'x'});
	advance(500);
	h.emit('run_error', {error: new Error('boom')});

	assert.doesNotMatch(flat(h.pane()), /▶/);
	assert.doesNotMatch(flat(h.spinner(0)), /TTFT 0\.25s/);
});

test('a run_start session id is adopted when the hook carried none', async () => {
	const store = new Map<string, unknown>();
	const first = createHarness(store);
	// The host answered onSessionStart without an id, so run_start is the only source.
	first.hooks().onSessionStart({source: 'startup'});
	first.emit('run_start', {sessionId: 'sess-adopted'});
	first.emit('model_request_start', {model: 'm/one'});
	advance(300);
	first.emit('text_delta', {delta: 'x'});
	advance(700);
	first.emit('model_request_end', {usage: {inputTokens: 1_000, outputTokens: 20}});
	await flushWrites();

	assert.equal(store.has('session:sess-adopted'), true);
	const resumed = createHarness(store);
	resumed.hooks().onSessionStart({source: 'startup', sessionId: 'sess-adopted'});
	assert.match(resumed.command().message, /1 request/);
});

test('a later run_start does not rewind an established session', () => {
	const store = new Map<string, unknown>();
	store.set('session:sess-x', {
		sessionId: 'sess-x',
		requests: [{model: 'm/other', startedAt: 0, outputTokens: 5}],
		subagents: [],
	});
	// The other session has figures of its own, so adopting its id would visibly replace ours.
	store.set('session:sess-other', {
		sessionId: 'sess-other',
		requests: [{model: 'm/stolen', startedAt: 0, outputTokens: 999}],
		subagents: [],
	});
	const h = createHarness(store);
	h.hooks().onSessionStart({source: 'startup', sessionId: 'sess-x'});
	h.emit('run_start', {sessionId: 'sess-x'});
	h.emit('model_request_start', {model: 'm/mine'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	// A nested run arriving with another id must not swap the session out from under us.
	h.emit('run_start', {sessionId: 'sess-other'});

	assert.match(h.command().message, /2 request/);
	assert.match(flat(h.pane()), /other/);
	assert.match(flat(h.pane()), /mine/);
	assert.doesNotMatch(flat(h.pane()), /stolen/);
});

test('a stored session keeps its id when a later run_start names another one', () => {
	const store = new Map<string, unknown>();
	store.set('session:sess-x', {
		sessionId: 'sess-x',
		requests: [{model: 'm/other', startedAt: 0, outputTokens: 5}],
		subagents: [],
	});
	const h = createHarness(store);
	h.hooks().onSessionStart({source: 'startup', sessionId: 'sess-x'});
	h.emit('run_start', {sessionId: 'sess-x'});
	h.emit('model_request_start', {model: 'm/mine'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	// A nested run arriving with another id must not swap the session out from under us.
	h.emit('run_start', {sessionId: 'sess-other'});

	// Nothing may be written under the other session's key.
	assert.equal(store.has('session:sess-other'), false);
});

test('a late run_start id must not discard data already collected without one', () => {
	const store = new Map<string, unknown>();
	// The id finally arrives, and that session already has stored figures to restore.
	store.set('session:sess-late', {
		sessionId: 'sess-late',
		requests: [{model: 'm/stored', startedAt: 0, outputTokens: 7}],
		subagents: [],
	});
	const h = createHarness(store);
	// The host answered onSessionStart without an id, so the first request lands anonymously.
	h.hooks().onSessionStart({source: 'startup'});
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/live-one'});
	advance(200);
	h.emit('text_delta', {delta: 'x'});
	advance(800);
	h.emit('model_request_end', {usage: {outputTokens: 20}});
	h.emit('run_start', {sessionId: 'sess-late'});

	// Restoring over live memory would silently drop the request that already happened.
	assert.match(flat(h.pane()), /live-one/);
});

test('a host that reports no surface does not try to open the pane', () => {
	const h = createHarness();
	h.setSurface(false);
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(200);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 30}});

	// The summary must still come back as text; only the pane is unavailable.
	assert.match(h.command().message, /1 request/);
	assert.equal(h.openedPane(), undefined);
});

test('a host without ui.capabilities still serves /metrics as text', () => {
	// Before cmdc 1.10.0 the property is absent; reading it unguarded throws in the handler and
	// the whole command dies on that host.
	const h = createHarness(undefined, {omitCapabilities: true});
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(200);
	h.emit('text_delta', {delta: 'x'});
	advance(800);
	h.emit('model_request_end', {usage: {outputTokens: 30}});

	assert.equal(h.openedPane(), undefined);
	assert.match(h.command().message, /1 request/);
});

test('a queued save captures a copy, not the live records it was scheduled with', async () => {
	const store = new Map<string, unknown>();
	const h = createHarness(store);
	h.hooks().onSessionStart({source: 'startup', sessionId: 'sess-copy'});
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'explore', description: 'find'});
	advance(500);
	// subagent_stop schedules the write, then progress mutates the same record in the same tick.
	h.emit('subagent_stop', {toolCallId: 'c1', tokensUsed: 100});
	h.emit('subagent_progress', {toolCallId: 'c1', tokensUsed: 99_999});
	// A request completing in the same tick must not reach the snapshot already scheduled.
	h.emit('model_request_start', {model: 'm/late'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	await flushWrites();

	const firstWrite = h.writes.find(entry => entry.key === 'session:sess-copy')!;
	// subagent_stop set tokensUsed=100 on the record before scheduling; the later progress event
	// (tokens = 99,999) mutates the live object, and must not be visible in that snapshot. With a
	// stored reference this assertion reads 99,999.
	assert.equal(firstWrite.value.subagents[0].tokens, 0);
	assert.equal(firstWrite.value.subagents[0].tokensUsed, 100);
	// The array itself is copied too: a request that lands after the write was scheduled must not
	// appear in it. With the live array aliased this reads 1.
	assert.equal(firstWrite.value.requests.length, 0);
});

test('a failing store write does not crash the mod or lose the in-memory figures', async () => {
	const h = createHarness(new Map(), {failWrites: true});
	h.hooks().onSessionStart({source: 'startup', sessionId: 'sess-fail'});
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	await flushWrites();

	// The write was rejected, but the session figures are still in memory and still render.
	assert.match(h.command().message, /1 request/);
});

test('a malformed stored session does not crash the restore', () => {
	const store = new Map<string, unknown>();
	store.set('session:sess-bad', {
		requests: [null, {model: 'm/one'}],
		// A partial child row: only the id, none of the fields a render reads directly.
		subagents: [null, {toolCallId: 'c1'}],
	});
	const h = createHarness(store);
	h.hooks().onSessionStart({source: 'reload', sessionId: 'sess-bad'});

	// The corrupt rows are skipped or normalised rather than crashing a render.
	const text = flat(h.pane());
	assert.match(flat(h.widget()), /session/);
	assert.match(h.command().message, /request/);
	assert.match(text, /⑂agent/);
	assert.match(text, /0 tool call/);
});
