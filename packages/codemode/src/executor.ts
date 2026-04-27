/**
 * Executor interface and DynamicWorkerExecutor implementation.
 *
 * The Executor interface is the core abstraction — implement it to run
 * LLM-generated code in any sandbox (Workers, QuickJS, Node VM, etc.).
 */

import { RpcTarget } from "cloudflare:workers";
import { normalizeCode } from "./normalize";
import { sanitizeToolPath } from "./utils";
import type { ToolDescriptors } from "./tool-types";
import type { ToolSet } from "ai";

export type ToolProviderTypes = string;

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

// ── ToolProvider ──────────────────────────────────────────────────────

/**
 * A minimal tool record — just a description and an execute function.
 * Use this for providers that supply their own `types` and don't need
 * schema-based type generation (e.g. stateTools).
 */
export type SimpleToolRecord = Record<
  string,
  { description?: string; execute: (args: unknown) => Promise<unknown> }
>;

/**
 * All tool record types accepted by a ToolProvider.
 */
export type ToolProviderTools = ToolDescriptors | ToolSet | SimpleToolRecord;

/**
 * A ToolProvider contributes tools to the codemode sandbox under a namespace.
 *
 * Each provider's tools are accessible as `name.toolName()` in sandbox code.
 * If `name` is omitted, tools are exposed under the default `codemode.*` namespace.
 *
 * @example Multiple providers with different namespaces
 * ```ts
 * createCodeTool({
 *   tools: [
 *     { name: "github", tools: githubTools },
 *     { name: "shell", tools: shellTools },
 *     { tools: aiTools }, // default "codemode" namespace
 *   ],
 *   executor,
 * });
 * // sandbox: github.listIssues(), shell.exec(), codemode.search()
 * ```
 */
export interface StaticToolProvider {
  /** Namespace prefix in the sandbox (e.g. "state", "mcp"). Defaults to "codemode". */
  name?: string;

  /** Tools exposed as `namespace.toolName()` in the sandbox. */
  tools: ToolProviderTools;

  /**
   * Model-facing provider documentation inserted into the codemode prompt.
   *
   * The field name is historical: codemode does not typecheck this content.
   * It may contain declaration-like snippets, prose documentation, examples,
   * or other guidance for the LLM.
   */
  types?: ToolProviderTypes;

  /**
   * When true, tools accept positional args instead of a single object arg.
   * The sandbox proxy uses `(...args)` and the dispatcher spreads the args array.
   *
   * Default tools use single-object args: `codemode.search({ query: "test" })`
   * Positional tools use normal args: `state.readFile("/path")`
   */
  positionalArgs?: boolean;
}

/**
 * Dynamic providers trade ahead-of-time tool enumeration for a single runtime
 * hook that receives any attempted dotted subpath under the provider namespace.
 *
 * This is the explicit "trust me, try it at runtime" escape hatch. If sandbox
 * code evaluates `mcp.someServer.foo.bar(1, 2)`, codemode forwards
 * `"foo.bar"` and `[1, 2]` to `callTool()` and lets the provider decide
 * whether that path is meaningful.
 */
export interface DynamicToolProvider {
  name?: string;
  callTool: (name: string, args: unknown[]) => Promise<unknown>;
  types?: ToolProviderTypes;
  positionalArgs?: boolean;
  tools?: never;
}

export type ToolProvider = StaticToolProvider | DynamicToolProvider;

// ── ResolvedProvider ──────────────────────────────────────────────────

/**
 * Internal resolved form of a ToolProvider, ready for execution.
 * The tool functions have been extracted and keyed by sanitized name.
 */
export interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  callTool?: (name: string, args: unknown[]) => Promise<unknown>;
  positionalArgs?: boolean;
}

// ── Executor ──────────────────────────────────────────────────────────

/**
 * An executor runs LLM-generated code in a sandbox, making the provided
 * tool functions callable under their namespace inside the sandbox.
 *
 * Implementations should never throw — errors are returned in `ExecuteResult.error`.
 *
 * @param code - The code to execute in the sandbox.
 * @param providersOrFns - An array of `ResolvedProvider` (preferred), or a
 *   plain `Record<string, fn>` for backwards compatibility (deprecated — will
 *   be removed in the next major version).
 */
export interface Executor {
  execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}

// ── ToolDispatcher ────────────────────────────────────────────────────

/**
 * An RpcTarget that dispatches tool calls from the sandboxed Worker
 * back to the host. Passed via Workers RPC to the dynamic Worker's
 * evaluate() method — no globalOutbound or Fetcher bindings needed.
 */
export class ToolDispatcher extends RpcTarget {
  #fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  #positionalArgs: boolean;
  #callTool?: (name: string, args: unknown[]) => Promise<unknown>;

  constructor(
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    positionalArgs = false,
    callTool?: (name: string, args: unknown[]) => Promise<unknown>
  ) {
    super();
    this.#fns = fns;
    this.#positionalArgs = positionalArgs;
    this.#callTool = callTool;
  }

  async call(name: string, argsJson: string): Promise<string> {
    try {
      const parsed = argsJson ? JSON.parse(argsJson) : [];
      const args = Array.isArray(parsed) ? parsed : [parsed];

      const fn = this.#fns[name];
      if (fn) {
        if (this.#positionalArgs) {
          const result = await fn(...args);
          return JSON.stringify({ result });
        }
        const result = await fn(args[0] ?? {});
        return JSON.stringify({ result });
      }

      // Dynamic providers intentionally do not predeclare their full tool
      // surface. When a static match is missing, we give the provider-level
      // hook the exact dotted path the sandbox attempted and let the remote side
      // decide whether it is meaningful.
      if (this.#callTool) {
        const result = await this.#callTool(name, args);
        return JSON.stringify({ result });
      }

      return JSON.stringify({ error: `Tool "${name}" not found` });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

// ── DynamicWorkerExecutor ─────────────────────────────────────────────

export interface DynamicWorkerExecutorOptions {
  loader: WorkerLoader;
  /**
   * Timeout in milliseconds for code execution. Defaults to 30000 (30s).
   */
  timeout?: number;
  /**
   * Controls outbound network access from sandboxed code.
   * - `null` (default): fetch() and connect() throw — sandbox is fully isolated.
   * - `undefined`: inherits parent Worker's network access (full internet).
   * - A `Fetcher`: all outbound requests route through this handler.
   */
  globalOutbound?: Fetcher | null;
  /**
   * Additional modules to make available in the sandbox.
   * Keys are module specifiers (e.g. `"mylib.js"`), values are module source code.
   *
   * Note: the key `"executor.js"` is reserved and will be ignored if provided.
   */
  modules?: Record<string, string>;
}

/**
 * Executes code in an isolated Cloudflare Worker via WorkerLoader.
 * Tool calls are dispatched via Workers RPC — the host passes
 * ToolDispatchers (one per namespace) to the Worker's evaluate() method.
 *
 * External fetch() and connect() are blocked by default via
 * `globalOutbound: null` (runtime-enforced). Pass a Fetcher to
 * `globalOutbound` to allow controlled outbound access.
 *
 * @example
 * ```ts
 * const result = await executor.execute(code, [
 *   { name: "codemode", fns: { search: searchFn } },
 *   { name: "state", fns: { readFile: readFileFn } },
 * ]);
 * // sandbox has both codemode.search() and state.readFile()
 * ```
 */
export class DynamicWorkerExecutor implements Executor {
  #loader: WorkerLoader;
  #timeout: number;
  #globalOutbound: Fetcher | null;
  #modules: Record<string, string>;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30000;
    this.#globalOutbound = options.globalOutbound ?? null;
    const { "executor.js": _, ...safeModules } = options.modules ?? {};
    this.#modules = safeModules;
  }

  async execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    // Backwards compat: detect old `execute(code, fns)` signature.
    let providers: ResolvedProvider[];
    if (!Array.isArray(providersOrFns)) {
      console.warn(
        "[@cloudflare/codemode] Passing raw fns to executor.execute() is deprecated. " +
          "Use ResolvedProvider[] instead. This will be removed in the next major version."
      );
      providers = [{ name: "codemode", fns: providersOrFns }];
    } else {
      providers = providersOrFns;
    }

    const normalized = normalizeCode(code);
    const timeoutMs = this.#timeout;

    // Provider names are no longer limited to a single identifier. A provider
    // path like `mcp.someServer` should become nested objects in the sandbox,
    // and each segment must remain stable across prompt generation, proxy
    // creation, and dispatcher lookup.
    const RESERVED_NAMES = new Set(["__dispatchers", "__logs"]);
    const seenNames = new Set<string>();
    const providerPaths = new Map<string, string[]>();
    for (const provider of providers) {
      const safePath = sanitizeToolPath(provider.name);
      const pathParts = safePath.split(".");
      for (const part of pathParts) {
        if (RESERVED_NAMES.has(part)) {
          return {
            result: undefined,
            error: `Provider name segment "${part}" is reserved`
          };
        }
      }
      const providerKey = pathParts.join(".");
      if (seenNames.has(providerKey)) {
        return {
          result: undefined,
          error: `Duplicate provider name "${provider.name}"`
        };
      }
      seenNames.add(providerKey);
      providerPaths.set(provider.name, pathParts);
    }

    // Generate a recursive Proxy global for each provider namespace.
    const proxyInits = providers.map((p) => {
      const pathParts = providerPaths.get(p.name)!;
      const providerKey = pathParts.join(".");
      const root = pathParts[0]!;
      const setupLines = [
        `    globalThis.${root} ??= {};`,
        ...pathParts.slice(1, -1).map((_, i) => {
          const child = pathParts.slice(0, i + 2).join(".");
          return `    ${child} ??= {};`;
        })
      ];
      const assignTarget = providerKey;
      return [
        ...setupLines,
        `    ${assignTarget} = (() => {`,
        `      const make = (path = []) => new Proxy(async () => {}, {`,
        `        get: (_, key) => typeof key === "string" ? (key === "$call" ? make(path) : make([...path, key])) : undefined,`,
        `        apply: async (_, __, args) => {`,
        `          const resJson = await __dispatchers[${JSON.stringify(providerKey)}].call(path.join("."), JSON.stringify(args));`,
        `          const data = JSON.parse(resJson);`,
        `          if (data.error) throw new Error(data.error);`,
        `          return data.result;`,
        `        }`,
        `      });`,
        `      return make();`,
        `    })();`
      ].join("\n");
    });

    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__dispatchers = {}) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      ...proxyInits,
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        ("
    ]
      .concat([normalized])
      .concat([
        ")(),",
        '        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ' +
          timeoutMs +
          "))",
        "      ]);",
        "      return { result, logs: __logs };",
        "    } catch (err) {",
        "      return { result: undefined, error: err.message, logs: __logs };",
        "    }",
        "  }",
        "}"
      ])
      .join("\n");

    // Build dispatcher map: { codemode: ToolDispatcher, state: ToolDispatcher, ... }
    // Dotted names stay dotted here so the recursive proxy can resolve
    // codemode.github.listIssues(...) -> "github.listIssues" at dispatch time.
    // sanitizeToolPath() also handles degenerate names the same way as the type
    // generators, so executor lookup stays aligned with the emitted paths.
    const dispatchers: Record<string, ToolDispatcher> = {};
    for (const provider of providers) {
      const providerKey = providerPaths.get(provider.name)!.join(".");
      if (provider.callTool) {
        dispatchers[providerKey] = new ToolDispatcher(
          {},
          provider.positionalArgs,
          provider.callTool
        );
        continue;
      }

      const sanitizedFns: Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      > = {};
      for (const [name, fn] of Object.entries(provider.fns ?? {})) {
        sanitizedFns[sanitizeToolPath(name)] = fn;
      }
      dispatchers[providerKey] = new ToolDispatcher(
        sanitizedFns,
        provider.positionalArgs
      );
    }

    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...this.#modules,
        "executor.js": executorModule
      },
      globalOutbound: this.#globalOutbound
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(dispatchers: Record<string, ToolDispatcher>): Promise<{
        result: unknown;
        error?: string;
        logs?: string[];
      }>;
    };
    const response = await entrypoint.evaluate(dispatchers);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs };
    }

    return { result: response.result, logs: response.logs };
  }
}
