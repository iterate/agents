/**
 * Shared constants and types used by both the AI SDK (`./ai`) and
 * TanStack AI (`./tanstack-ai`) entry points.
 *
 * No dependency on `ai`, `@tanstack/ai`, or `zod`.
 */

import type {
  Executor,
  ToolProvider,
  ToolProviderTools,
  ToolProviderTypes
} from "./executor";

export const DEFAULT_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

export interface CreateCodeToolOptions {
  tools: ToolProviderTools | ToolProvider[];
  executor: Executor;
  /**
   * Custom tool description. Use {{types}} as a placeholder for the generated type definitions.
   */
  description?: string;
}

export type CodeInput = { code: string };
export type CodeOutput = { code: string; result: unknown; logs?: string[] };

/**
 * Resolve a provider's model-facing documentation block.
 *
 * The historical field name is `types`, but codemode treats the value as prompt
 * material rather than something to be typechecked. The resolver accepts a
 * plain string, an already-started promise, or a thunk so expensive remote docs
 * can be fetched only when prompt assembly actually needs them.
 *
 * Failures are intentionally softened into a short warning block. Runtime tool
 * calling can still succeed even if documentation lookup is temporarily
 * unavailable, and surfacing the warning to the model is more informative than
 * silently dropping the provider from the prompt.
 */
export async function resolveProviderTypes(
  providerName: string,
  types: ToolProviderTypes | undefined
): Promise<string | undefined> {
  if (!types) return undefined;

  try {
    if (typeof types === "string") return types;
    if (typeof types === "function") return await types();
    return await types;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      `// Documentation for provider ${providerName} could not be loaded.`,
      `// Error: ${message}`
    ].join("\n");
  }
}

/**
 * Check if the tools option is an array of ToolProviders.
 * A plain ToolSet/ToolDescriptors is a Record (not an array).
 */
function isToolProviderArray(
  tools: ToolProviderTools | ToolProvider[]
): tools is ToolProvider[] {
  return Array.isArray(tools);
}

/**
 * Normalize the tools option into a list of ToolProviders.
 * Raw ToolSet/ToolDescriptors are wrapped as a single default provider.
 */
export function normalizeProviders(
  tools: ToolProviderTools | ToolProvider[]
): ToolProvider[] {
  if (isToolProviderArray(tools)) {
    return tools;
  }
  return [{ tools }];
}
