# cmd-metrics

A [Command Code](https://commandcode.ai) mod that puts generation metrics on screen while the
model works.

| Metric | Meaning |
|---|---|
| **TPS** | Output tokens per second over a short rolling window, so a pause does not drag the number down. |
| **TTFT** | Time to first token, measured from the model request start. |
| **duration** | Wall time of the model request. |
| **tokens ÷ (duration − TTFT)** | The rate reported for a finished request, so prefill does not dilute it. |
| **cache %** | `cacheReadTokens ÷ inputTokens` — how much of the prompt was served from the prompt cache. |

## Install

```bash
cmd mods add malikshi/cmd-metrics        # from GitHub
cmd mods add -g malikshi/cmd-metrics     # for your user instead of this project
```

Or try it without installing:

```bash
cmd --mod ./status-metrics.ts
```

## What it shows

On the spinner line, for the request in flight:

```
TPS 42 · TTFT 1.8s · 3.4s
```

Between requests it shows the last request's summary, and every running sub-agent:

```
⏱ 3.4s · TTFT 1.8s · 87 t/s · cache 51%   ⑂explore TTFT 2.6s 1m40s
```

`/metrics` opens a pane with the request history and a sub-agent table:

```
Requests
  #1 deepseek-v4.1-flash  TTFT 1.6s  ⏱ 2.1s  132 tok  cache 51%  263 t/s  tool_calls
  #2 deepseek-v4.1-flash  TTFT 1.7s  ⏱ 1.8s   14 tok  cache 99%  165 t/s  stop

Sub-agents
  ✓ ⑂general  Run echo cache  TTFT 1.7s  ⏱ 3.9s  21k tok  9.4k t/s  1 tool call(s)
```

`/metrics` also prints a one-line summary; the run-end notice repeats it. The session cache
rate is **token-weighted** (`ΣcacheRead ÷ Σinput`), not an average of per-request percentages,
so a small cold request cannot cancel out a large warm prompt.

## How metrics are measured

Everything comes from the public mod API — no patching of Command Code internals.

- **Requests.** `model_request_start` / `model_request_end` bracket each inference call; the
  first `thinking_*`, `text_delta` or `message_update` event marks the first token.
- **Usage.** `model_request_end` carries `inputTokens`, `outputTokens`, `cacheReadTokens` and
  `cacheWriteTokens`. `inputTokens` already includes cached tokens — Command Code's own cost
  path subtracts cache reads and writes back out before pricing fresh input — so the cache hit
  rate divides by `inputTokens` directly.
- **Sub-agents.** `subagent_start` / `subagent_progress` / `subagent_stop` bracket a child run,
  and the `<usage>` block in the `agent` tool result carries its exact duration and token
  total.

### The one number that is approximate

A sub-agent's **TTFT** is spawn → first forwarded child event. Command Code's sub-agent
translator consumes the child run's own `text_delta` and `thinking_delta` into a private
counter and never re-emits them, and child runs do not receive user mods, so no mod can
observe a child's true first token. The earliest point on the child's timeline is therefore
the first `subagent_progress`. The pane header states this on every render rather than
implying token-level precision. Its duration, token count and TPS are exact.

## Development

```bash
npm test        # 22 unit tests, no build step (node --experimental-strip-types)
npm run typecheck
```

`types/harness.d.ts` declares the slice of `@commandcode/harness` this mod compiles against;
that package is bundled with the CLI rather than published, so the declaration is what
`tsc` checks against. The mod itself is loaded by the real CLI, which supplies the genuine API.

## License

MIT
