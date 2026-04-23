import { quoteProp } from "./utils";

export type DeclTree = Map<string, DeclTree | string>;

export function createDeclTree(): DeclTree {
  return new Map();
}

export function insertDecl(
  tree: DeclTree,
  path: string[],
  leafDecl: string
): void {
  let current = tree;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i]!;
    const existing = current.get(part);
    if (existing instanceof Map) {
      current = existing;
    } else {
      const next: DeclTree = new Map();
      current.set(part, next);
      current = next;
    }
  }
  current.set(path[path.length - 1]!, leafDecl);
}

export function emitDeclTree(tree: DeclTree, indent = "\t"): string {
  const lines: string[] = [];
  for (const [key, value] of tree.entries()) {
    const prop = quoteProp(key);
    if (typeof value === "string") {
      const leafLines = value.split("\n");
      for (const line of leafLines) {
        if (line.includes("__PROP__")) {
          lines.push(`${indent}${line.trimStart().replace("__PROP__", prop)}`);
        } else if (line.startsWith("\t")) {
          lines.push(`${indent}${line.slice(1)}`);
        } else {
          lines.push(line);
        }
      }
    } else {
      lines.push(`${indent}${prop}: {`);
      lines.push(emitDeclTree(value, indent + "\t"));
      lines.push(`${indent}};`);
    }
  }
  return lines.join("\n");
}
