import { describe, expect, it } from "vitest";
import { dynamicTools } from "../dynamic";

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
});
