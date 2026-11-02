// status-metrics.ts — per-request TPS, TTFT, duration and cache metrics plus a /metrics pane.
//
// exports: default | SessionAverages | tpsText | formatDuration | formatTokens | formatRate | formatPercent | cachePercent | parseUsageBlock | modelLabel | sessionAverages
// used_by: tests/metrics.test.ts → formatters, sessionAverages, parseUsageBlock, modelLabel, default
// rules:   Every figure comes from the public mod API; no Command Code internals are patched. A request with no observed first token reports no TTFT and no TPS. Store writes are serialized through one chain.
// agent:   claude-sonnet-4 | anthropic | 2026-11-02 | code-review | fixed k/M and percent boundary rounding, clamped the session cache rate, cleared phantom live state on run_end, hardened restore against malformed rows, surfaced store write failures, and completed CodeDNA headers

import type {ModApi} from '@commandcode/harness';

const TPS_WINDOW_MS = 2_000;
const TPS_MIN_WINDOW_MS = 800;
const TPS_PAUSE_MS = 1_500;
const TPS_MAX = 1_000;
const TPS_SMOOTHING = 0.25;
const HISTORY_DISPLAY_LIMIT = 50;
const SPINNER_SUBAGENTS = 3;
const TOKENS_PER_K = 1_000;
const TOKENS_PER_M = 1_000_000;
const PANE_ID = 'metrics';
const SESSION_KEY_PREFIX = 'session:';
const INDEX_KEY = 'sessions';
const MAX_PERSISTED_SESSIONS = 20;

const sessionKey = (sessionId: string): string => `${SESSION_KEY_PREFIX}${sessionId}`;

interface Usage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

interface RequestRecord {
	model: string;
	startedAt: number;
	firstTokenAt?: number;
	endedAt?: number;
	durationMs?: number;
	ttftMs?: number;
	outputTokens?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cachePercent?: number;
	tps?: number;
	stopReason?: string;
}

interface SubagentRecord {
	toolCallId: string;
	type: string;
	description: string;
	startedAt: number;
	firstActivityAt?: number;
	lastActivityAt?: number;
	endedAt?: number;
	durationMs?: number;
	ttftMs?: number;
	toolCalls: number;
	tokens: number;
	tokensUsed?: number;
	tps?: number;
	status?: string;
}

interface RequestMetric {
	ttftMs?: number;
	tps?: number;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
}

interface SubagentMetric {
	tokens?: number;
	tokensUsed?: number;
	ttftMs?: number;
	durationMs?: number;
	tps?: number;
	toolCalls?: number;
}

// The stored shape of one session, keyed by suite sessionId.
// Rules:   A reload and a restart hand the same sessionId, so figures are restored; another session starts from zero.
interface PersistedSession {
	sessionId?: string;
	requests: RequestRecord[];
	subagents: SubagentRecord[];
}

export interface SessionAverages {
	requests: number;
	subagents: number;
	avgTtftMs?: number;
	avgTps?: number;
	avgDurationMs?: number;
	cachePercent?: number;
	totalTokens: number;
	// Kept as their own block rather than folded into the parent averages above: a child's
	// TTFT is spawn → first forwarded event, which is not comparable with a measured one.
	subagentAvgTtftMs?: number;
	subagentAvgTps?: number;
	subagentAvgDurationMs?: number;
	subagentAvgTokens?: number;
	subagentToolCalls?: number;
}

interface TextNode {
	type: 'text';
	text: string;
	color?: string;
	dim?: boolean;
	bold?: boolean;
}

interface RowNode {
	type: 'row';
	children: TextNode[];
}

interface ButtonNode {
	type: 'button';
	label: string;
	hotkey?: string;
	onPress: () => void;
}

type Line = TextNode | RowNode | ButtonNode;

export function tpsText(tps: number): string {
	const value = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	return `TPS ${value}`;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
	if (ms < 1_000) return `${(ms / 1_000).toFixed(2)}s`;
	if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1_000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

// One shared magnitude formatter, so tokens and rates never disagree at a unit boundary.
// Rules: round inside the unit before choosing it — 999.6 reads 1.0k and 9,999 reads 10k, never
// a bare 1000 or 10.0k; 999,999 reads 1.0M, never 1000k. Rates keep one decimal in k (12.4k);
// tokens drop it from 10k up (12k), which is the documented shape.
const formatMagnitude = (value: number, isRate: boolean): string => {
	if (value < TOKENS_PER_K) return String(value);
	const thousands = isRate
		? Math.round(value / 100) / 10
		: value < 10 * TOKENS_PER_K
			? Math.round(value / 100) / 10
			: Math.round(value / TOKENS_PER_K);
	// Rules:   roll to M when the rounded k value reaches 1000, so 999,949 reads 1.0M, never 999.9k+1.
	if (thousands >= TOKENS_PER_K) return `${(value / TOKENS_PER_M).toFixed(1)}M`;
	if (isRate || thousands < 10) return `${thousands.toFixed(1)}k`;
	return `${thousands}k`;
};

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return '0';
	return formatMagnitude(Math.round(tokens), false);
}

export function formatRate(tps: number | undefined): string {
	if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return '—';
	const rounded = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	return `${formatMagnitude(rounded, true)} t/s`;
}

// Cache hit rate for one usage block.
// Rules:   inputTokens already counts cached tokens, so divide cacheReadTokens by it directly; clamp at 100 and return undefined for a non-positive or non-finite prompt.
export function cachePercent(usage: Usage | undefined): number | undefined {
	const inputTokens = Number(usage?.inputTokens ?? 0);
	if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
	const cacheReadTokens = Number(usage?.cacheReadTokens ?? 0) || 0;
	const percent = (cacheReadTokens / inputTokens) * 100;
	if (!Number.isFinite(percent) || percent < 0) return undefined;
	return Math.min(100, percent);
}

export function formatPercent(percent: number | undefined): string {
	if (percent === undefined || !Number.isFinite(percent)) return '—';
	// Rules:   round before choosing the shape, so 9.96 reads 10% like an exact 10, never 10.0%.
	const rounded = percent > 0 && percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent);
	if (rounded > 0 && rounded < 10) return `${rounded.toFixed(1)}%`;
	return `${Math.round(rounded)}%`;
}

const averageOf = (values: number[]): number | undefined =>
	values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

// Session aggregates for the widget, the pane and the /metrics summary.
// Rules:   TTFT, TPS, duration and cache average parent requests only; the approximate child TTFT never dilutes them. Cache is token-weighted and clamped at 100. totalTokens sums parent and child usage.
export function sessionAverages(
	requests: RequestMetric[],
	subagents: SubagentMetric[] = [],
): SessionAverages {
	const totalInput = requests.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0);
	const totalCacheRead = requests.reduce((sum, record) => sum + (record.cacheReadTokens ?? 0), 0);
	const requestTokens = requests.reduce(
		(sum, record) => sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
		0,
	);
	const subagentTokens = subagents.reduce(
		(sum, subagent) => sum + (subagent.tokensUsed ?? subagent.tokens ?? 0),
		0,
	);
	const averages: SessionAverages = {
		requests: requests.length,
		subagents: subagents.length,
		totalTokens: requestTokens + subagentTokens,
	};
	const avgTtftMs = averageOf(
		requests.map(record => record.ttftMs).filter((ttft): ttft is number => ttft !== undefined),
	);
	if (avgTtftMs !== undefined) averages.avgTtftMs = avgTtftMs;
	const avgTps = averageOf(
		requests.map(record => record.tps).filter((tps): tps is number => tps !== undefined),
	);
	if (avgTps !== undefined) averages.avgTps = avgTps;
	const avgDurationMs = averageOf(
		requests
			.map(record => record.durationMs)
			.filter((duration): duration is number => duration !== undefined),
	);
	if (avgDurationMs !== undefined) averages.avgDurationMs = avgDurationMs;
	if (totalInput > 0) averages.cachePercent = Math.min(100, (totalCacheRead / totalInput) * 100);

	// Rules:   child figures keep their own fields so a parent average is never confused for a child one.
	const definedOnly = (values: (number | undefined)[]): number[] =>
		values.filter((value): value is number => value !== undefined);
	const subagentTtft = averageOf(definedOnly(subagents.map(subagent => subagent.ttftMs)));
	if (subagentTtft !== undefined) averages.subagentAvgTtftMs = subagentTtft;
	const subagentTps = averageOf(definedOnly(subagents.map(subagent => subagent.tps)));
	if (subagentTps !== undefined) averages.subagentAvgTps = subagentTps;
	const subagentDuration = averageOf(definedOnly(subagents.map(subagent => subagent.durationMs)));
	if (subagentDuration !== undefined) averages.subagentAvgDurationMs = subagentDuration;
	const perSubagentTokens = definedOnly(subagents.map(subagent => subagent.tokensUsed));
	if (perSubagentTokens.length > 0) averages.subagentAvgTokens = averageOf(perSubagentTokens);
	const perSubagentToolCalls = definedOnly(subagents.map(subagent => subagent.toolCalls));
	if (perSubagentToolCalls.length > 0)
		averages.subagentToolCalls = averageOf(perSubagentToolCalls);
	return averages;
}

export function parseUsageBlock(text: string): {
	durationMs?: number;
	totalTokens?: number;
	turns?: number;
	toolUses?: number;
} {
	const block = /<usage>([\s\S]*?)<\/usage>/.exec(text);
	if (!block) return {};
	const read = (key: string): number | undefined => {
		const match = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(block[1]);
		return match ? Number(match[1]) : undefined;
	};
	return {
		durationMs: read('duration_ms'),
		totalTokens: read('total_tokens'),
		turns: read('turns'),
		toolUses: read('tool_uses'),
	};
}

export function modelLabel(model: string): string {
	const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
	return tail.length > 0 ? tail : model;
}

function resultText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (!Array.isArray(result)) return '';
	return result
		.map(part => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object') {
				const text = (part as {text?: unknown}).text;
				if (typeof text === 'string') return text;
			}
			return '';
		})
		.join('\n');
}

export default function (cmd: ModApi): void {
	let current: RequestRecord | undefined;
	// Every request of the session is kept: the figures are session-wide.
	// Rules:   never shift history at a cap — that turns session totals into a trailing window; only the pane caps its rows.
	let history: RequestRecord[] = [];
	let sessionId: string | undefined;
	const subagents = new Map<string, SubagentRecord>();
	let samples: {at: number; tokens: number}[] = [];
	let smoothed: number | undefined;
	let lastTokenAt = 0;

	const resetRate = (): void => {
		samples = [];
		smoothed = undefined;
		lastTokenAt = 0;
	};

	const reset = (): void => {
		current = undefined;
		resetRate();
	};

	// Restore one session's figures from the synchronous store read.
	// Rules:   each session has its own key, so an older session restores itself, not the latest. The file is user-editable, so skip any row without the fields a render needs instead of crashing.
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === 'object' && value !== null;
	const restore = (id: string | undefined): void => {
		if (id === undefined) return;
		const stored = cmd.store.get<PersistedSession>(sessionKey(id));
		if (!isRecord(stored)) return;
		const requests = Array.isArray(stored.requests) ? stored.requests : [];
		history = requests.filter(
			(record): record is RequestRecord => isRecord(record) && typeof record.model === 'string',
		);
		subagents.clear();
		for (const subagent of Array.isArray(stored.subagents) ? stored.subagents : []) {
			if (!isRecord(subagent) || typeof subagent.toolCallId !== 'string') continue;
			const record = subagent as unknown as SubagentRecord;
			// Rules:   fill the fields a render reads directly, since formatDuration/formatRate tolerate undefined but the raw text and arithmetic do not.
			if (typeof record.type !== 'string') record.type = 'agent';
			if (typeof record.description !== 'string') record.description = '';
			if (typeof record.toolCalls !== 'number') record.toolCalls = 0;
			if (typeof record.tokens !== 'number') record.tokens = 0;
			if (typeof record.startedAt !== 'number') record.startedAt = 0;
			subagents.set(record.toolCallId, record);
		}
	};

	// Single-writer promise chain around cmd.store.set.
	// Rules:   cmd.store.set rewrites the whole file with no lock and the host does not await session hooks, so unsequenced writes interleave and corrupt the JSON — every write goes through this one chain. A failure surfaces once as a warning and never crashes the mod.
	let writes: Promise<void> = Promise.resolve();
	let isWriteFailing = false;
	const enqueueWrite = (write: () => Promise<void>): void => {
		writes = writes
			.then(write, write)
			.then(
				() => {
					isWriteFailing = false;
				},
				() => {
					// Rules:   notify on the first failure only — one broken store must not spam.
					if (!isWriteFailing) cmd.ui.notify('metrics: could not save session figures', 'warning');
					isWriteFailing = true;
				},
			);
	};

	const save = (id: string | undefined): void => {
		if (id === undefined) return;
		const snapshot: PersistedSession = {
			sessionId: id,
			requests: history,
			subagents: [...subagents.values()],
		};
		const key = sessionKey(id);
		enqueueWrite(async () => {
			const known = cmd.store.get<string[]>(INDEX_KEY);
			const ordered = [id, ...(Array.isArray(known) ? known.filter(entry => entry !== id) : [])];
			await cmd.store.set(key, snapshot);
			await cmd.store.set(INDEX_KEY, ordered.slice(0, MAX_PERSISTED_SESSIONS));
			for (const evicted of ordered.slice(MAX_PERSISTED_SESSIONS)) {
				await cmd.store.delete(sessionKey(evicted));
			}
		});
	};

	const rateFor = (now: number, tokens: number): number | undefined => {
		// A short rolling window, never a cumulative average, so a pause does not drag
		// the number down and a burst does not inflate it forever.
		if (samples.length > 0 && tokens < samples[samples.length - 1].tokens) resetRate();
		if (samples.length === 0) {
			samples.push({at: now, tokens});
			lastTokenAt = now;
			return undefined;
		}

		const previous = samples[samples.length - 1];
		if (tokens > previous.tokens) lastTokenAt = now;
		samples.push({at: now, tokens});
		while (samples.length > 1 && now - samples[0].at > TPS_WINDOW_MS) samples.shift();

		if (now - lastTokenAt > TPS_PAUSE_MS) {
			// Thinking or stalled: no rate to show, and the next burst starts from a
			// fresh window.
			samples = [{at: now, tokens}];
			smoothed = undefined;
			return undefined;
		}

		const first = samples[0];
		const windowMs = now - first.at;
		if (windowMs < TPS_MIN_WINDOW_MS) return undefined;

		const delta = tokens - first.tokens;
		if (delta <= 0) return undefined;

		const rate = delta / (windowMs / 1_000);
		if (!Number.isFinite(rate) || rate <= 0 || rate > TPS_MAX) {
			// Rules:   a counter jump is not generation — start the window over without a rate.
			samples = [{at: now, tokens}];
			smoothed = undefined;
			lastTokenAt = now;
			return undefined;
		}

		smoothed =
			smoothed === undefined ? rate : smoothed * (1 - TPS_SMOOTHING) + rate * TPS_SMOOTHING;
		return smoothed;
	};

	const subagentRate = (subagent: SubagentRecord): number | undefined => {
		// Same formula as a parent request: tps = tokens ÷ (duration − ttft), so prefill and
		// thinking time do not dilute the generation rate. While the child is still running,
		// the window is spawn → last activity, not spawn → now.
		if (subagent.tps !== undefined) return subagent.tps;
		const end = subagent.endedAt ?? subagent.lastActivityAt;
		const ttft = subagent.ttftMs;
		const tokens = subagent.tokensUsed ?? subagent.tokens;
		if (end === undefined || ttft === undefined) return undefined;
		const generationMs = end - subagent.startedAt - ttft;
		if (tokens <= 0 || generationMs < 100) return undefined;
		return tokens / (generationMs / 1_000);
	};

	const runningSubagents = (): SubagentRecord[] =>
		[...subagents.values()].filter(subagent => subagent.endedAt === undefined);

	const spinnerNodes = (now: number, tokens: number): Line[] => {
		const nodes: TextNode[] = [];
		if (current) {
			const rate = rateFor(now, tokens);
			if (rate !== undefined) nodes.push({type: 'text', text: tpsText(rate), color: 'cyan'});
			const ttftMs =
				current.firstTokenAt === undefined ? undefined : current.firstTokenAt - current.startedAt;
			if (ttftMs !== undefined)
				nodes.push({type: 'text', text: `TTFT ${formatDuration(ttftMs)}`, color: 'green'});
			nodes.push({
				type: 'text',
				text: formatDuration(now - current.startedAt),
				dim: true,
			});
		} else {
			const last = history[history.length - 1];
			if (last) {
				nodes.push({
					type: 'text',
					text: `⏱ ${formatDuration(last.durationMs)} · TTFT ${formatDuration(last.ttftMs)} · ${formatRate(last.tps)} · cache ${formatPercent(last.cachePercent)}`,
					dim: true,
				});
			}
		}

		for (const subagent of runningSubagents().slice(0, SPINNER_SUBAGENTS)) {
			const ttft = subagent.ttftMs;
			nodes.push({
				type: 'text',
				text:
					ttft === undefined
						? `⑂${subagent.type} ${formatDuration(now - subagent.startedAt)}`
						: `⑂${subagent.type} TTFT ${formatDuration(ttft)} ${formatDuration(now - subagent.startedAt)}`,
				color: 'magenta',
			});
		}

		return nodes;
	};

	const summaryLine = (): string => {
		if (history.length === 0 && subagents.size === 0)
			return 'metrics: no completed model requests yet';
		const stats = sessionAverages(history, [...subagents.values()]);
		const parts = [`metrics: ${stats.requests} request(s)`];
		if (stats.avgTtftMs !== undefined) parts.push(`avg TTFT ${formatDuration(stats.avgTtftMs)}`);
		if (stats.avgTps !== undefined) parts.push(`avg ${formatRate(stats.avgTps)}`);
		if (stats.avgDurationMs !== undefined)
			parts.push(`avg duration ${formatDuration(stats.avgDurationMs)}`);
		if (stats.cachePercent !== undefined) parts.push(`cache ${formatPercent(stats.cachePercent)}`);
		parts.push(`total ${formatTokens(stats.totalTokens)} tok`);
		if (stats.subagents > 0) {
			// The child rates come from the same aggregate the widget reads, so the summary and
			// the widget can never disagree about what a sub-agent averaged.
			let subagentPart = `${stats.subagents} sub-agent(s)`;
			if (stats.subagentAvgTtftMs !== undefined)
				subagentPart += ` avg TTFT ${formatDuration(stats.subagentAvgTtftMs)}`;
			if (stats.subagentAvgTps !== undefined)
				subagentPart += ` avg ${formatRate(stats.subagentAvgTps)}`;
			if (stats.subagentAvgDurationMs !== undefined)
				subagentPart += ` avg ${formatDuration(stats.subagentAvgDurationMs)}`;
			if (stats.subagentToolCalls !== undefined)
				subagentPart += ` · ${Math.round(stats.subagentToolCalls)} tool call(s) each`;
			parts.push(subagentPart);
		}
		return parts.join(' · ');
	};

	const avgWidgetLines = (): Line[] => {
		if (history.length === 0 && subagents.size === 0) {
			// Keep the placement occupied: an empty render would drop the line entirely, which
			// reads as "the mod stopped working" rather than "no requests yet".
			return [
				{
					type: 'row',
					children: [
						{type: 'text', text: 'session', dim: true},
						{type: 'text', text: 'no requests yet', dim: true},
					],
				},
			];
		}
		const stats = sessionAverages(history, [...subagents.values()]);
		const nodes: TextNode[] = [{type: 'text', text: 'session', dim: true}];
		if (stats.avgTtftMs !== undefined)
			nodes.push({type: 'text', text: `TTFT ${formatDuration(stats.avgTtftMs)}`, color: 'green'});
		if (stats.avgTps !== undefined)
			nodes.push({type: 'text', text: formatRate(stats.avgTps), color: 'cyan'});
		if (stats.avgDurationMs !== undefined)
			nodes.push({type: 'text', text: `⏱ ${formatDuration(stats.avgDurationMs)}`, color: 'white'});
		if (stats.cachePercent !== undefined)
			nodes.push({type: 'text', text: `cache ${formatPercent(stats.cachePercent)}`, color: 'yellow'});
		nodes.push({type: 'text', text: `${formatTokens(stats.totalTokens)} tok`, color: 'magenta'});
		const lines: Line[] = [{type: 'row', children: nodes}];

		if (stats.subagents > 0) {
			// A child's TTFT is approximate, so it gets its own line rather than sharing the
			// parent row where it could read as a measured figure.
			const childNodes: TextNode[] = [
				{type: 'text', text: `⑂${stats.subagents}`, color: 'magenta'},
			];
			if (stats.subagentAvgTtftMs !== undefined)
				childNodes.push({
					type: 'text',
					text: `TTFT ${formatDuration(stats.subagentAvgTtftMs)}`,
					color: 'green',
				});
			if (stats.subagentAvgTps !== undefined)
				childNodes.push({
					type: 'text',
					text: formatRate(stats.subagentAvgTps),
					color: 'magenta',
				});
			if (stats.subagentAvgDurationMs !== undefined)
				childNodes.push({
					type: 'text',
					text: `⏱ ${formatDuration(stats.subagentAvgDurationMs)}`,
					color: 'white',
				});
			if (stats.subagentAvgTokens !== undefined)
				childNodes.push({
					type: 'text',
					text: `${formatTokens(stats.subagentAvgTokens)} tok avg`,
					dim: true,
				});
			lines.push({type: 'row', children: childNodes});
		}
		return lines;
	};

	const requestLines = (): Line[] => {
		const lines: Line[] = [
			{type: 'text', text: 'Requests', bold: true},
			{
				type: 'text',
				text: 'TTFT = first streamed token · duration = model request wall time · t/s = output tokens ÷ generation time',
				dim: true,
			},
		];
		if (current) {
			const elapsed = Date.now() - current.startedAt;
			const ttft =
				current.firstTokenAt === undefined
					? 'TTFT —'
					: `TTFT ${formatDuration(current.firstTokenAt - current.startedAt)}`;
			lines.push({
				type: 'row',
				children: [
					{type: 'text', text: '▶', color: 'cyan'},
					{type: 'text', text: modelLabel(current.model), bold: true},
					{type: 'text', text: ttft, color: 'green'},
					{type: 'text', text: formatDuration(elapsed), dim: true},
				],
			});
		}
		if (history.length === 0 && !current) {
			lines.push({type: 'text', text: 'no model requests yet in this run', dim: true});
		}
		// Oldest rows are dropped from the pane, never renumbered: #57 must stay #57.
		const firstShown = Math.max(0, history.length - HISTORY_DISPLAY_LIMIT);
		if (firstShown > 0) {
			lines.push({
				type: 'text',
				text: `… ${firstShown} earlier request(s) in the session totals`,
				dim: true,
			});
		}
		for (const [index, record] of history.entries()) {
			if (index < firstShown) continue;
			lines.push({
				type: 'row',
				children: [
					{type: 'text', text: `#${index + 1}`, dim: true},
					{type: 'text', text: modelLabel(record.model)},
					{type: 'text', text: `TTFT ${formatDuration(record.ttftMs)}`, color: 'green'},
					{type: 'text', text: `⏱ ${formatDuration(record.durationMs)}`},
					{type: 'text', text: `${formatTokens(record.outputTokens ?? 0)} tok`, dim: true},
					{type: 'text', text: `cache ${formatPercent(record.cachePercent)}`, color: 'yellow'},
					{type: 'text', text: formatRate(record.tps), color: 'cyan'},
					...(record.stopReason ? [{type: 'text' as const, text: record.stopReason, dim: true}] : []),
				],
			});
		}
		return lines;
	};

	const subagentLines = (): Line[] => {
		if (subagents.size === 0) return [];
		const now = Date.now();
		const lines: Line[] = [
			{type: 'text', text: 'Sub-agents', bold: true},
			{
				type: 'text',
				text: 'TTFT = spawn → first child activity (the harness forwards no child token deltas) · t/s = tokens ÷ (duration − TTFT)',
				dim: true,
			},
		];
		for (const subagent of subagents.values()) {
			const running = subagent.endedAt === undefined;
			const rate = subagentRate(subagent);
			const ttft = subagent.ttftMs;
			const elapsedMs =
				subagent.durationMs ??
				(subagent.endedAt ?? subagent.lastActivityAt ?? now) - subagent.startedAt;
			lines.push({
				type: 'row',
				children: [
					{type: 'text', text: running ? '▶' : '✓', color: running ? 'magenta' : 'green'},
					{type: 'text', text: `⑂${subagent.type}`, bold: true},
					{type: 'text', text: subagent.description, dim: true},
					{
						type: 'text',
						text: ttft === undefined ? 'TTFT —' : `TTFT ${formatDuration(ttft)}`,
						color: 'green',
					},
					{
						type: 'text',
						text: `⏱ ${formatDuration(elapsedMs)}`,
					},
					{
						type: 'text',
						text: `${formatTokens(subagent.tokensUsed ?? subagent.tokens)} tok`,
						dim: true,
					},
					{
						type: 'text',
						text: rate === undefined ? '—' : formatRate(rate),
						color: 'magenta',
					},
					{
						type: 'text',
						text: `${subagent.toolCalls} tool call(s)`,
						dim: true,
					},
					...(subagent.status ? [{type: 'text' as const, text: subagent.status, dim: true}] : []),
				],
			});
		}
		return lines;
	};

	const repaint = (): void => {
		// A pane redraws on a state write (cmd.state.set repaints every widget and pane);
		// the counter is only there to make the write always look like a change.
		cmd.state.set('repaint', (cmd.state.get<number>('repaint') ?? 0) + 1);
	};

	cmd.ui.override('spinner', (props, next) => {
		const nodes = spinnerNodes(Date.now(), Number(props.tokens) || 0);
		if (nodes.length === 0) return undefined;
		return [...nodes, ...(next?.() ?? [])];
	});

	cmd.ui.widget({
		placement: 'below-editor',
		render: () => avgWidgetLines(),
	});

	cmd.ui.pane({
		id: PANE_ID,
		title: 'Request metrics',
		render: () => {
			const lines: Line[] = [...requestLines()];
			const subagentSection = subagentLines();
			if (subagentSection.length > 0) lines.push({type: 'text', text: ''}, ...subagentSection);
			lines.push(
				{type: 'text', text: ''},
				{
					type: 'button',
					label: 'Close',
					hotkey: 'c',
					onPress: () => cmd.ui.closePane(PANE_ID),
				},
			);
			return lines;
		},
	});

	cmd.addCommand({
		name: 'metrics',
		description: 'Show TPS, TTFT, and duration for each model request and sub-agent',
		handler: () => {
			if (cmd.ui.capabilities.surface) cmd.ui.openPane(PANE_ID);
			return {message: summaryLine()};
		},
	});

	// A run is one submitted prompt, not one session: clearing the aggregates here would
	// blank the below-editor line every time a prompt is sent and make "session" means "this
	// prompt". Only the live request state is per-run; totals reset in the session hooks.
	cmd.on('run_start', () => {
		reset();
	});

	cmd.on('model_request_start', event => {
		const payload = event as {model?: unknown};
		resetRate();
		current = {
			model: typeof payload.model === 'string' ? payload.model : '',
			startedAt: Date.now(),
		};
	});

	const markFirstToken = (): void => {
		if (current && current.firstTokenAt === undefined) current.firstTokenAt = Date.now();
	};
	cmd.on('thinking_start', markFirstToken);
	cmd.on('thinking_delta', markFirstToken);
	cmd.on('text_delta', markFirstToken);
	// Some replies stream only as accumulated message updates (a tool-call-only turn often
	// has no text block at all); without this the first token would be missed entirely.
	cmd.on('message_update', markFirstToken);

	cmd.on('model_request_end', event => {
		if (!current) return;
		const payload = event as {usage?: Usage; stopReason?: unknown};
		const endedAt = Date.now();
		const durationMs = endedAt - current.startedAt;
		// A request whose first token was never observed has no TTFT. Recording the duration
		// instead would turn prefill into a measured TTFT and drag the session average up.
		const ttftMs =
			current.firstTokenAt === undefined
				? undefined
				: current.firstTokenAt - current.startedAt;
		const outputTokens = Number(payload.usage?.outputTokens ?? 0) || 0;
		const generationMs = ttftMs === undefined ? undefined : durationMs - ttftMs;
		const tps =
			outputTokens > 0 && generationMs !== undefined && generationMs > 0
				? outputTokens / (generationMs / 1_000)
				: undefined;
		const record: RequestRecord = {
			...current,
			endedAt,
			durationMs,
			outputTokens,
		};
		if (ttftMs !== undefined) record.ttftMs = ttftMs;
		const inputTokens = Number(payload.usage?.inputTokens ?? 0) || 0;
		if (inputTokens > 0) record.inputTokens = inputTokens;
		const cacheReadTokens = Number(payload.usage?.cacheReadTokens ?? 0) || 0;
		if (cacheReadTokens > 0) record.cacheReadTokens = cacheReadTokens;
		const cacheWriteTokens = Number(payload.usage?.cacheWriteTokens ?? 0) || 0;
		if (cacheWriteTokens > 0) record.cacheWriteTokens = cacheWriteTokens;
		const cached = cachePercent(payload.usage);
		if (cached !== undefined) record.cachePercent = cached;
		if (tps !== undefined) record.tps = tps;
		if (typeof payload.stopReason === 'string') record.stopReason = payload.stopReason;
		history.push(record);
		current = undefined;
		resetRate();
		save(sessionId);
		repaint();
	});

	cmd.on('subagent_start', event => {
		const payload = event as {
			toolCallId?: unknown;
			subagentType?: unknown;
			description?: unknown;
		};
		if (typeof payload.toolCallId !== 'string') return;
		const startedAt = Date.now();
		subagents.set(payload.toolCallId, {
			toolCallId: payload.toolCallId,
			type: typeof payload.subagentType === 'string' ? payload.subagentType : 'agent',
			description: typeof payload.description === 'string' ? payload.description : '',
			startedAt,
			toolCalls: 0,
			tokens: 0,
		});
		repaint();
	});

	cmd.on('subagent_progress', event => {
		const payload = event as {toolCallId?: unknown; tokensUsed?: unknown};
		if (typeof payload.toolCallId !== 'string') return;
		const subagent = subagents.get(payload.toolCallId);
		if (!subagent) return;
		const now = Date.now();
		const tokens = Number(payload.tokensUsed);
		if (Number.isFinite(tokens) && tokens > subagent.tokens) subagent.tokens = tokens;
		// subagent_progress is the first child signal the harness forwards: child text_delta
		// and thinking_delta are counted by its translator and never re-emitted, so the
		// child's own first token is not observable. The first forwarded child event is the
		// earliest measurable point on the child's timeline, and is what TTFT is measured to.
		subagent.firstActivityAt ??= now;
		subagent.ttftMs ??= now - subagent.startedAt;
		subagent.lastActivityAt = now;
		subagent.toolCalls += 1;
		repaint();
	});

	// Finalise a finished child's duration, TTFT and TPS.
	// Rules:   TTFT is the first forwarded child event; a child that never emitted one is measured from spawn, so its whole wait reads as prefill.
	const finalizeSubagent = (subagent: SubagentRecord): void => {
		if (subagent.endedAt === undefined) return;
		const durationMs =
			subagent.durationMs ?? subagent.endedAt - subagent.startedAt;
		subagent.durationMs = durationMs;
		subagent.ttftMs ??= subagent.firstActivityAt
			? subagent.firstActivityAt - subagent.startedAt
			: durationMs;
		const tokens = subagent.tokensUsed ?? subagent.tokens;
		const generationMs = durationMs - subagent.ttftMs;
		if (tokens > 0 && generationMs > 0) subagent.tps = tokens / (generationMs / 1_000);
	};

	cmd.on('subagent_stop', event => {
		const payload = event as {toolCallId?: unknown; tokensUsed?: unknown; status?: unknown};
		if (typeof payload.toolCallId !== 'string') return;
		const subagent = subagents.get(payload.toolCallId);
		if (!subagent) return;
		subagent.endedAt = Date.now();
		const tokens = Number(payload.tokensUsed);
		if (Number.isFinite(tokens) && tokens > 0) subagent.tokensUsed = tokens;
		if (typeof payload.status === 'string') subagent.status = payload.status;
		finalizeSubagent(subagent);
		save(sessionId);
		repaint();
	});

	cmd.on('tool_completed', event => {
		const payload = event as {toolCallId?: unknown; toolName?: unknown; result?: unknown};
		if (payload.toolName !== 'agent' || typeof payload.toolCallId !== 'string') return;
		const subagent = subagents.get(payload.toolCallId);
		if (!subagent) return;
		const usage = parseUsageBlock(resultText(payload.result));
		if (usage.durationMs !== undefined) subagent.durationMs = usage.durationMs;
		if (usage.totalTokens !== undefined) subagent.tokensUsed = usage.totalTokens;
		// Rules:   with no usage block there is no duration to trust — leave the child running and let subagent_stop close it, never end it at zero elapsed time.
		if (subagent.durationMs !== undefined) {
			subagent.endedAt ??= subagent.startedAt + subagent.durationMs;
		}
		finalizeSubagent(subagent);
		repaint();
	});

	cmd.on('run_end', () => {
		// A cancelled or failed request never emits model_request_end, so the live state must be
		// dropped here or the spinner reports a phantom request forever.
		reset();
		if (history.length > 0) cmd.ui.notify(summaryLine());
	});

	// Rules:   a hot reload and a /reload restart both arrive with the same sessionId, so restore the stored figures instead of wiping them — the factory re-runs and memory is gone, so cmd.store is the only source. A different or older session starts from zero.
	cmd.hooks({
		onSessionStart: ({sessionId: next}) => {
			reset();
			history = [];
			subagents.clear();
			sessionId = next;
			restore(next);
		},
		onSessionEnd: () => {
			save(sessionId);
			reset();
		},
	});
}
