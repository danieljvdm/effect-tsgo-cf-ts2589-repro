# Plugin-only TS2589 in `@effect/tsgo`

> A user file containing only `import "@cloudflare/workers-types";` typechecks cleanly with `tsgo` — but fails with `error TS2589: Type instantiation is excessively deep and possibly infinite.` as soon as the `@effect/language-service` plugin is enabled with default rule severities.
>
> The trigger is one specific rule (`effectInFailure`). Disabling just that rule makes the failure go away. The user program contains no Effect code at all.

---

## What this repo demonstrates

Three tsconfigs over a single one-line source file, run against a freshly patched `@effect/tsgo`:

| Config | Plugin? | Rule severities | Result |
| --- | --- | --- | --- |
| `tsconfig.json` | enabled | defaults | **fail (TS2589)** |
| `tsconfig.no-plugin.json` | removed | — | pass |
| `tsconfig.rule-off.json` | enabled | `effectInFailure: "off"` | pass |

Same source, same `@cloudflare/workers-types` types loaded, same `tsgo` binary. The only knob being toggled is whether the plugin's `effectInFailure` rule runs.

`--extendedDiagnostics` makes the cause obvious — total type-instantiations balloon **12×** from 2,090 to 25,040 as soon as the rule is enabled, which is what trips tsgo's depth budget:

| Config | Symbols | Types | **Instantiations** |
| --- | ---: | ---: | ---: |
| `tsconfig.json` (plugin on, defaults) | 76,071 | 16,836 | **25,040** |
| `tsconfig.no-plugin.json` | 43,189 | 6,745 | 2,090 |
| `tsconfig.rule-off.json` (`effectInFailure: "off"`) | 43,303 | 6,749 | 2,090 |

`darwin-arm64`, `@effect/tsgo@0.5.1`, `@typescript/native-preview@7.0.0-dev.20260425.1`. Files in program: 91 (stdlib + jsx + `@cloudflare/workers-types/index.d.ts`). Reproduces identically on `0.4.0`, so this is **not** a 0.5.x regression — it predates the 0.5.0 fix that added `internal/effecttest/effect_in_failure_ts2589_test.go`.

## Quick run

```sh
git clone https://github.com/danieljvdm/effect-tsgo-cf-ts2589-repro.git
cd effect-tsgo-cf-ts2589-repro
bun install   # or: pnpm install / npm install
              # postinstall runs `effect-tsgo patch`, which patches
              # @typescript/native-preview's bundled tsgo binary in-place
              # to load the @effect/language-service plugin.

bun run tsgo:plugin       # → exits non-zero with "error TS2589: Type instantiation is excessively deep and possibly infinite."
bun run tsgo:no-plugin    # → exits 0
bun run tsgo:rule-off     # → exits 0 (effectInFailure disabled)

bun run verify            # runs all three; expects only the plugin run to fail
```

> `@effect/tsgo` does not ship its own typecheck CLI — it patches the binary inside `@typescript/native-preview` so that `tsgo --noEmit -p ...` invocations load the bundled `@effect/language-service` plugin. The three `tsconfig.*.json` files in this repo control whether the plugin is loaded and which rule severities apply when it is.

## How this matches the upstream regression test

This three-way matrix mirrors the assertions in [`internal/effecttest/effect_in_failure_ts2589_test.go`](https://github.com/Effect-TS/tsgo/blob/8869556/internal/effecttest/effect_in_failure_ts2589_test.go) added in commit [`8869556`](https://github.com/Effect-TS/tsgo/commit/8869556) (shipped in `0.5.0`):

- plugin enabled, default severities → expect TS2589 ✓
- plugin enabled, `effectInFailure: "off"` → expect no TS2589 ✓
- plugin disabled → expect no TS2589 ✓

The difference from the upstream test:

- The test uses a hand-built `Wrap<Wrap<…25 deep…>>` generic with `Data.TaggedEnum.Kind` inside `Effect.fail<…>` to drive instantiation.
- This repo uses a **real-world bare import of an ambient `.d.ts` module** (`@cloudflare/workers-types`) — no Effect code in the user program at all.

The 0.5.0 typeparser refactor reduces overhead for the test's failure shape but does **not** address the bare-import case here.

## Suspected mechanism

`internal/rules/effect_in_failure.go` walks every node in the source file post-order and for each one calls:

```go
nodeType := ctx.TypeParser.GetTypeAtLocation(node)
if nodeType == nil { continue }
effect := ctx.TypeParser.StrictEffectType(nodeType, node)
```

Even on a one-line file, the import statement's bound symbols cause `GetTypeAtLocation` to lazily resolve the imported namespace's full type graph through the underlying tsgo checker. For `@cloudflare/workers-types` (thousands of generic type aliases — `Cf*` / `D1*` / `KV*` / `WebSocket*` / `Cache*` / web-platform types) that lazy resolution cascades, producing ~23,000 instantiations that the underlying tsgo would never have performed for the same user code without the plugin.

`StrictEffectType` correctly returns `nil` for these non-Effect types — but only after the checker work is already done. Commit [`8869556`](https://github.com/Effect-TS/tsgo/commit/8869556) reduced typeparser property-lookup overhead for cases where the type itself is the cost driver; here the cost driver is the **upstream type-checker work performed before the typeparser is even consulted**, so that fix doesn't apply.

## Generality of the trigger

The same TS2589 (with the same instantiation explosion) reproduces on any of:

- `import "@cloudflare/workers-types";` (this repo)
- `import "@cloudflare/workers-types/experimental";`
- `import "wrangler";`
- `import "miniflare";`
- `import "@cloudflare/vite-plugin";`

…each of which transitively reaches `@cloudflare/workers-types`. It does **not** reproduce on `import "vite";`, so the trigger is specifically the size + shape of the `@cloudflare/workers-types` type graph, not module loading per se. Any project that compiles a TypeScript file (even a Vite/Wrangler config) that transitively pulls in `@cloudflare/workers-types` and has the `@effect/language-service` plugin enabled is affected.

## Suggested mitigations (any of these would help)

1. **Cheap-bail in `effectInFailure` before invoking the checker on AST node kinds that cannot possibly resolve to an Effect** — e.g., `ImportClause`, `ImportSpecifier`, raw `StringLiteral`, plain identifier import bindings. The current post-order walk visits every node.
2. **Memoize `GetTypeAtLocation` results within a single rule run for a given source file.**
3. **Allow consumers to opt the rule out by source-file glob** without disabling the rule project-wide. Currently the only options are project-wide rule disable or full plugin disable.

Workaround consumers can apply today: per-program override via `diagnosticSeverity: { "effectInFailure": "off" }` in the affected `tsconfig.json`'s plugin entry. See `tsconfig.rule-off.json`.

## Files in this repo

- `src/repro.ts` — the one-line user program (`import "@cloudflare/workers-types";`).
- `tsconfig.json` — plugin enabled, default rules. Expected: TS2589.
- `tsconfig.no-plugin.json` — plugin removed. Expected: clean.
- `tsconfig.rule-off.json` — plugin enabled, `effectInFailure: "off"`. Expected: clean.
- `package.json` — `tsgo:plugin`, `tsgo:no-plugin`, `tsgo:rule-off`, `verify` scripts; `postinstall` runs `effect-tsgo patch`.

## Environment

Reproduced on:

- macOS 25.3.0, Apple Silicon (`darwin-arm64`).
- `@effect/tsgo` `0.5.1` (latest at time of writing); also confirmed on `0.4.0`.
- `@typescript/native-preview` `7.0.0-dev.20260425.1`.
- `bun` package manager — `pnpm` and `npm` reproduce identically.
