// The single line below is enough to trigger plugin-only TS2589
// when @effect/language-service's `effectInFailure` rule is enabled.
// No Effect code anywhere in this program — the failure comes purely
// from the rule walking AST nodes whose types resolve to the very
// large @cloudflare/workers-types ambient module.
import "@cloudflare/workers-types";
