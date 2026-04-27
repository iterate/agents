import type { ToolProvider, ToolProviderTypes } from "./executor";

/**
 * A dynamic tool provider is the escape hatch for integrations that do not
 * know their full tool surface ahead of time, or deliberately do not want to
 * pay the cost of discovering it up front.
 *
 * Instead of contributing a static `tools` record, a dynamic provider accepts
 * arbitrary dotted subpaths at runtime and decides for itself whether they are
 * valid. In other words, if sandbox code evaluates
 * `mcp.someServer.files.read({ path: "/tmp/x" })`, codemode forwards the
 * trailing path `"files.read"` and the raw argument array to `callTool()`.
 *
 * The `types` field name is inherited from existing codemode providers, but for
 * dynamic providers it should be read much more literally as *LLM-facing
 * documentation*. Codemode does not parse, typecheck, or validate this text as
 * TypeScript. The string is inserted verbatim into the prompt block shown to
 * the model. That means it can contain declaration-like examples, prose API
 * notes, usage conventions, or any other guidance that helps the model produce
 * sensible calls.
 *
 * We intentionally keep this field synchronous in the minimal dynamic-provider
 * design. Tool descriptions are assembled eagerly by the surrounding codemode
 * integrations, and trying to sneak lazy/async prompt material through that
 * path made the implementation much more invasive than the runtime feature
 * justified. If we ever want remote discovery-backed docs, that should likely
 * be a separate API with its own explicit lifecycle.
 */
export interface DynamicToolsOptions {
  /**
   * Namespace path exposed in sandbox code.
   *
   * Dotted names are allowed. For example, `name: "mcp.someServer"` makes the
   * provider reachable as `mcp.someServer.*` in generated code.
   */
  name?: string;

  /**
   * Runtime handler for tool calls under this namespace.
   *
   * Codemode forwards the full dotted subpath below `name` verbatim. If the
   * model attempts `mcp.someServer.foo.bar(1, 2)`, this function receives
   * `name === "foo.bar"` and `args === [1, 2]`.
   */
  callTool: (name: string, args: unknown[]) => Promise<unknown>;

  /**
   * Optional model-facing documentation inserted into the codemode prompt.
   *
   * Despite the legacy field name, this does not need to be valid TypeScript.
   * It is best thought of as provider documentation for the LLM: declaration
   * snippets, examples, conventions, caveats, etc.
   */
  types?: ToolProviderTypes;

  /**
   * Marks this provider as preferring positional-argument examples.
   *
   * The runtime hook always receives the raw argument array regardless; this
   * flag only affects how surrounding codemode integrations think about the
   * provider surface.
   */
  positionalArgs?: boolean;
}

/**
 * Construct a codemode provider whose tool surface is resolved dynamically at
 * runtime instead of from a static `tools` record.
 *
 * The helper exists so we can keep the public API crisp and intentional. Users
 * opt into the dynamic behavior explicitly instead of smuggling it through the
 * generic `ToolProvider` shape.
 */
export function dynamicTools(options: DynamicToolsOptions): ToolProvider {
  return {
    name: options.name,
    callTool: options.callTool,
    types: options.types,
    positionalArgs: options.positionalArgs
  };
}
