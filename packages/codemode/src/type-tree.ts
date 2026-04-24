import { quoteProp } from "./utils";

export interface DeclNode {
  self?: string;
  children: Map<string, DeclNode>;
}

export function createDeclTree(): DeclNode {
  return { children: new Map() };
}

export function countDeclNodes(tree: DeclNode): number {
  let count = 0;
  for (const node of tree.children.values()) {
    count += 1;
    count += countDeclNodes(node);
  }
  return count;
}

export function insertDecl(
  tree: DeclNode,
  path: string[],
  leafDecl: string
): void {
  let current = tree;
  for (let i = 0; i < path.length; i++) {
    const part = path[i]!;
    let child = current.children.get(part);
    if (!child) {
      child = { children: new Map() };
      current.children.set(part, child);
    }
    if (i === path.length - 1) {
      child.self = leafDecl;
    }
    current = child;
  }
}

function emitLeaf(leafDecl: string, indent: string, prop: string): string[] {
  const lines: string[] = [];
  for (const line of leafDecl.split("\n")) {
    if (line.includes("__PROP__")) {
      const trimmed = line.trimStart();
      const idx = trimmed.indexOf("__PROP__");
      const replaced = `${trimmed.slice(0, idx)}${prop}${trimmed.slice(idx + "__PROP__".length)}`;
      lines.push(`${indent}${replaced}`);
    } else if (line.startsWith("\t")) {
      lines.push(`${indent}${line.slice(1)}`);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

export function emitDeclTree(tree: DeclNode, indent = "\t"): string {
  const lines: string[] = [];
  for (const [key, node] of tree.children.entries()) {
    const prop = quoteProp(key);
    if (node.self && node.children.size === 0) {
      lines.push(...emitLeaf(node.self, indent, prop));
      continue;
    }

    if (!node.self && node.children.size > 0) {
      lines.push(`${indent}${prop}: {`);
      const childText = emitDeclTree(node, indent + "\t");
      if (childText) lines.push(childText);
      lines.push(`${indent}};`);
      continue;
    }

    lines.push(`${indent}${prop}: {`);
    lines.push(...emitLeaf(node.self!, indent + "\t", quoteProp("$call")));
    for (const [childKey, childNode] of node.children.entries()) {
      const childProp = quoteProp(childKey);
      if (childNode.self && childNode.children.size === 0) {
        lines.push(...emitLeaf(childNode.self, indent + "\t", childProp));
        continue;
      }
      lines.push(`${indent}\t${childProp}: {`);
      if (childNode.self) {
        lines.push(
          ...emitLeaf(childNode.self, indent + "\t\t", quoteProp("$call"))
        );
      }
      const nestedChildText = emitDeclTree(childNode, indent + "\t\t");
      if (nestedChildText) lines.push(nestedChildText);
      lines.push(`${indent}\t};`);
    }
    lines.push(`${indent}};`);
  }
  return lines.join("\n");
}
