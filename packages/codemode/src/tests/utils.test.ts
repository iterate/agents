import { describe, it, expect } from "vitest";
import { sanitizeToolName, sanitizeToolPath } from "../utils";

describe("sanitizeToolName", () => {
  it("should replace hyphens with underscores", () => {
    expect(sanitizeToolName("get-weather")).toBe("get_weather");
  });

  it("should replace dots with underscores", () => {
    expect(sanitizeToolName("api.v2.search")).toBe("api_v2_search");
  });

  it("should replace spaces with underscores", () => {
    expect(sanitizeToolName("my tool")).toBe("my_tool");
  });

  it("should prefix digit-leading names with underscore", () => {
    expect(sanitizeToolName("3drender")).toBe("_3drender");
  });

  it("should append underscore to reserved words", () => {
    expect(sanitizeToolName("class")).toBe("class_");
    expect(sanitizeToolName("return")).toBe("return_");
    expect(sanitizeToolName("delete")).toBe("delete_");
  });

  it("should strip special characters", () => {
    expect(sanitizeToolName("hello@world!")).toBe("helloworld");
  });

  it("should handle empty string", () => {
    expect(sanitizeToolName("")).toBe("_");
  });

  it("should handle string with only special characters", () => {
    // $ is a valid identifier character, so "@#$" → "$"
    expect(sanitizeToolName("@#$")).toBe("$");
    expect(sanitizeToolName("@#!")).toBe("_");
  });

  it("should leave valid identifiers unchanged", () => {
    expect(sanitizeToolName("getWeather")).toBe("getWeather");
    expect(sanitizeToolName("_private")).toBe("_private");
    expect(sanitizeToolName("$jquery")).toBe("$jquery");
  });

  it("should preserve double dollar signs", () => {
    expect(sanitizeToolName("$$ref")).toBe("$$ref");
  });
});

describe("sanitizeToolPath", () => {
  it("should sanitize dotted paths segment-by-segment", () => {
    expect(sanitizeToolPath("foo-bar.baz-qux")).toBe("foo_bar.baz_qux");
  });

  it("should preserve nesting dots", () => {
    expect(sanitizeToolPath("bla.bla.doIt")).toBe("bla.bla.doIt");
  });

  it("should fall back to a valid identifier for empty paths", () => {
    expect(sanitizeToolPath("")).toBe("_");
    expect(sanitizeToolPath("...")).toBe(sanitizeToolName("..."));
  });
});
