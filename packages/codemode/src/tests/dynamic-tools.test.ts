import { describe, expect, it } from "vitest";
import { dynamicTools } from "../dynamic-tools";
import { resolveProviderTypes } from "../shared";

describe("dynamicTools", () => {
  it("should build a dynamic provider with runtime hook", async () => {
    const callTool = async (name: string, args: unknown[]) => ({ name, args });
    const provider = dynamicTools({
      name: "mcp.someServer",
      callTool,
      types: "declare const mcp: {};"
    });

    expect(provider.name).toBe("mcp.someServer");
    expect("callTool" in provider && provider.callTool).toBe(callTool);
  });

  it("should resolve async documentation lazily", async () => {
    let called = false;
    const provider = dynamicTools({
      callTool: async () => null,
      types: async () => {
        called = true;
        return "Remote docs";
      }
    });

    expect(called).toBe(false);
    expect(await resolveProviderTypes("codemode", provider.types)).toBe(
      "Remote docs"
    );
    expect(called).toBe(true);
  });

  it("should surface documentation load failures as warning text", async () => {
    const provider = dynamicTools({
      callTool: async () => null,
      types: async () => {
        throw new Error("network down");
      }
    });

    await expect(
      resolveProviderTypes("mcp.someServer", provider.types)
    ).resolves.toContain(
      "Documentation for provider mcp.someServer could not be loaded."
    );
  });
});
