/**
 * TanStack AI integration for codemode.
 *
 * Provides the same capabilities as `@cloudflare/codemode/ai` but returns
 * TanStack AI-compatible tools for use with `chat()` from `@tanstack/ai`.
 *
 * @example
 * ```ts
 * import { createCodeTool, tanstackTools } from "@cloudflare/codemode/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * const codeTool = createCodeTool({
 *   tools: [tanstackTools(myServerTools)],
 *   executor,
 * });
 *
 * const stream = chat({
 *   adapter: openaiText("gpt-4o"),
 *   tools: [codeTool],
 *   messages,
 * });
 * ```
 */

import { toolDefinition, convertSchemaToJsonSchema } from "@tanstack/ai";
import type {
  Tool as TanStackTool,
  ServerTool,
  JSONSchema as TanStackJSONSchema
} from "@tanstack/ai";
import { z } from "zod";
import type { JSONSchema7 } from "json-schema";
import type {
  ToolProvider,
  ToolProviderTools,
  ResolvedProvider,
  SimpleToolRecord,
  DynamicToolProvider,
  StaticToolProvider
} from "./executor";
import { normalizeCode } from "./normalize";
import { filterTools, extractFns } from "./resolve";
import {
  DEFAULT_DESCRIPTION,
  type CreateCodeToolOptions,
  type CodeOutput,
  normalizeProviders
} from "./shared";
import { jsonSchemaToType } from "./json-schema-types";
import { sanitizeToolPath, toPascalCase, escapeJsDoc } from "./utils";
import {
  countDeclNodes,
  createDeclTree,
  emitDeclTree,
  insertDecl,
  insertDeclTree
} from "./type-tree";

export type { CreateCodeToolOptions, CodeInput, CodeOutput } from "./shared";
export { DEFAULT_DESCRIPTION, normalizeProviders } from "./shared";
export { resolveProvider } from "./resolve";

const codeSchema = z.object({
  code: z
    .string()
    .meta({ description: "JavaScript async arrow function to execute" })
});

function toJsonSchema7(schema: unknown): JSONSchema7 | null {
  const converted = convertSchemaToJsonSchema(schema as TanStackJSONSchema);
  if (!converted) return null;
  return converted as unknown as JSONSchema7;
}

export function generateTypes(
  tools: TanStackTool[],
  namespace = "codemode"
): string {
  const declTree = createDeclTree();
  const namespacePath = sanitizeToolPath(namespace).split(".");
  const rootTree = createDeclTree();
  let availableTypes = "";

  for (const tool of tools) {
    const safePath = sanitizeToolPath(tool.name);
    const pathParts = safePath.split(".");
    const flatSafeName = pathParts.join("_");
    const typeName = toPascalCase(flatSafeName);

    try {
      const inputJsonSchema = tool.inputSchema
        ? toJsonSchema7(tool.inputSchema)
        : null;
      const outputJsonSchema = tool.outputSchema
        ? toJsonSchema7(tool.outputSchema)
        : null;

      const inputType = inputJsonSchema
        ? jsonSchemaToType(inputJsonSchema, `${typeName}Input`)
        : `type ${typeName}Input = unknown`;

      const outputType = outputJsonSchema
        ? jsonSchemaToType(outputJsonSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramDescs = (() => {
        try {
          if (!inputJsonSchema?.properties) return [];
          return Object.entries(inputJsonSchema.properties)
            .filter(
              ([, propSchema]) =>
                propSchema &&
                typeof propSchema === "object" &&
                (propSchema as JSONSchema7).description
            )
            .map(
              ([fieldName, propSchema]) =>
                `@param input.${fieldName} - ${(propSchema as JSONSchema7).description}`
            );
        } catch {
          return [];
        }
      })();

      const jsdocLines: string[] = [];
      if (tool.description?.trim()) {
        jsdocLines.push(
          escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " "))
        );
      } else {
        jsdocLines.push(escapeJsDoc(tool.name));
      }
      for (const pd of paramDescs) {
        jsdocLines.push(escapeJsDoc(pd.replace(/\r?\n/g, " ")));
      }

      const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
      insertDecl(
        declTree,
        pathParts,
        `\t/**\n${jsdocBody}\n\t */\n\t__PROP__: (input: ${typeName}Input) => Promise<${typeName}Output>;`
      );
    } catch {
      availableTypes += `\ntype ${typeName}Input = unknown`;
      availableTypes += `\ntype ${typeName}Output = unknown`;

      insertDecl(
        declTree,
        pathParts,
        `\t/**\n\t * ${escapeJsDoc(tool.name)}\n\t */\n\t__PROP__: (input: ${typeName}Input) => Promise<${typeName}Output>;`
      );
    }
  }

  insertDeclTree(rootTree, namespacePath.slice(1), declTree);
  const availableTools = `\ndeclare const ${namespacePath[0]}: {${countDeclNodes(rootTree) ? `\n${emitDeclTree(rootTree)}\n` : ""}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}

export function tanstackTools(
  tools: TanStackTool[],
  name?: string
): ToolProvider {
  const filtered = tools.filter(
    (t) => !("needsApproval" in t && t.needsApproval != null)
  );

  const toolRecord: SimpleToolRecord = {};
  for (const tool of filtered) {
    if (tool.execute) {
      toolRecord[tool.name] = {
        description: tool.description,
        execute: async (args: unknown) => tool.execute!(args)
      };
    }
  }

  const ns = name ?? "codemode";
  const types = generateTypes(filtered, ns);

  return { name: ns === "codemode" ? undefined : ns, tools: toolRecord, types };
}

export function createCodeTool(options: CreateCodeToolOptions): ServerTool {
  const providers = normalizeProviders(options.tools);
  const typeBlocks: string[] = [];
  const resolvedProviders: ResolvedProvider[] = [];

  for (const provider of providers) {
    const providerName = provider.name ?? "codemode";

    if ("callTool" in provider) {
      const dynamic = provider as DynamicToolProvider;
      const types = dynamic.types;
      if (types) typeBlocks.push(types);
      const resolved: ResolvedProvider = {
        name: providerName,
        fns: {},
        callTool: dynamic.callTool
      };
      if (dynamic.positionalArgs) resolved.positionalArgs = true;
      resolvedProviders.push(resolved);
      continue;
    }

    const staticProvider = provider as StaticToolProvider;
    const filtered = filterTools(staticProvider.tools);
    const types =
      staticProvider.types ?? generateTypesFromRecord(filtered, providerName);
    typeBlocks.push(types);

    const resolved: ResolvedProvider = {
      name: providerName,
      fns: extractFns(filtered)
    };
    if (staticProvider.positionalArgs) resolved.positionalArgs = true;
    resolvedProviders.push(resolved);
  }

  const typeBlock = typeBlocks.filter(Boolean).join("\n\n");
  const description = (options.description ?? DEFAULT_DESCRIPTION).replace(
    "{{types}}",
    typeBlock
  );

  const def = toolDefinition({
    name: "codemode_execute" as const,
    description,
    inputSchema: codeSchema
  });

  return def.server(async ({ code }) => {
    const normalizedCode = normalizeCode(code);
    const executeResult = await options.executor.execute(
      normalizedCode,
      resolvedProviders
    );

    if (executeResult.error) {
      const logCtx = executeResult.logs?.length
        ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
        : "";
      throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
    }

    const output: CodeOutput = { code, result: executeResult.result };
    if (executeResult.logs) output.logs = executeResult.logs;
    return output;
  });
}

function generateTypesFromRecord(
  tools: ToolProviderTools,
  namespace: string
): string {
  const declTree = createDeclTree();
  const namespacePath = sanitizeToolPath(namespace).split(".");
  const rootTree = createDeclTree();
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safePath = sanitizeToolPath(toolName);
    const pathParts = safePath.split(".");
    const flatSafeName = pathParts.join("_");
    const typeName = toPascalCase(flatSafeName);
    const description =
      "description" in tool
        ? (tool as Record<string, unknown>).description
        : undefined;

    availableTypes += `\ntype ${typeName}Input = unknown`;
    availableTypes += `\ntype ${typeName}Output = unknown`;

    const descStr =
      typeof description === "string" && description.trim()
        ? escapeJsDoc(description.trim().replace(/\r?\n/g, " "))
        : escapeJsDoc(toolName);

    insertDecl(
      declTree,
      pathParts,
      `\t/**\n\t * ${descStr}\n\t */\n\t__PROP__: (input: ${typeName}Input) => Promise<${typeName}Output>;`
    );
  }

  insertDeclTree(rootTree, namespacePath.slice(1), declTree);
  const availableTools = `\ndeclare const ${namespacePath[0]}: {${countDeclNodes(rootTree) ? `\n${emitDeclTree(rootTree)}\n` : ""}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
