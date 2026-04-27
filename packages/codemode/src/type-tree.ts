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

export function insertDeclTree(
  target: DeclNode,
  path: string[],
  tree: DeclNode
) {
  if (path.length === 0) {
    if (tree.self) target.self = tree.self;
    for (const [key, child] of tree.children.entries()) {
      target.children.set(key, child);
    }
    return target;
  }

  let current = target;
  for (const part of path) {
    let child = current.children.get(part);
    if (!child) {
      child = { children: new Map() };
      current.children.set(part, child);
    }
    current = child;
  }

  if (tree.self) current.self = tree.self;
  for (const [key, child] of tree.children.entries()) {
    current.children.set(key, child);
  }

  return path.length ? current : target;
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
      // Avoid String.replace here: replacement strings treat $$ specially,
      // which would mangle valid tool names like "$$ref".
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
    // When a tool name is both callable itself and a namespace prefix (for
    // example "files" and "files.read"), we expose the callable leaf as
    // $call so both shapes remain representable in ambient object types.
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
