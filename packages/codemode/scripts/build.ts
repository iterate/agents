import { execSync } from "node:child_process";
import { build } from "tsdown";

const tsconfig = process.argv.includes("--tsconfig")
  ? process.argv[process.argv.indexOf("--tsconfig") + 1]
  : undefined;

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/index.ts",
      "src/ai.ts",
      "src/mcp.ts",
      "src/dynamic.ts",
      "src/tanstack-ai.ts"
    ],
    tsconfig,
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  execSync("oxfmt --write ./dist/*.d.ts");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
