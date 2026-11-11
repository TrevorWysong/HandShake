// Every screen remounts when another identity signs in (App.tsx,
// `RequireSession`), so what a screen reads never shows to the next person.
// What can outlive it is a step it started: an `await` that finishes after
// the switch, then writes to a store kept per identity (identityScope.ts)
// -- the last person's order in the next one's bag, their checkout choices
// as the next one's. So every such write after an `await` must be in a step
// that took `stillSignedIn()` first, and checks it.
//
// This reads the app's source, so a new screen can't forget: the stores
// kept per identity are found from what registers with identityScope.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const at = join(dir, name);
    return statSync(at).isDirectory() ? files(at) : /\.tsx?$/.test(name) ? [at] : [];
  });
}

/// The hooks of every store kept per identity: each file in store/ that
/// registers with identityScope, and every `use…` it exports.
function perIdentityHooks(): Set<string> {
  const hooks = new Set<string>();
  for (const file of files(join(SRC, "store"))) {
    const text = readFileSync(file, "utf8");
    if (!/\b(perIdentity|forEachIdentity)\(/.test(text) || file.endsWith("identityScope.ts")) continue;
    for (const [, name] of text.matchAll(/export (?:const|function) (use[A-Z]\w*)/g)) hooks.add(name);
  }
  return hooks;
}

interface Write {
  file: string;
  line: number;
  text: string;
}

/// Writes to a per-identity store that follow an `await` in a step that
/// never took `stillSignedIn()`.
function unguardedWrites(): Write[] {
  const hooks = perIdentityHooks();
  const found: Write[] = [];
  for (const file of files(SRC).filter((f) => !f.includes("/store/"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    /// What each name in the file is bound to.
    const bound = new Map<string, string>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer.getText(source);
        if (ts.isIdentifier(node.name)) bound.set(node.name.text, init);
        else if (ts.isObjectBindingPattern(node.name)) for (const el of node.name.elements) if (ts.isIdentifier(el.name)) bound.set(el.name.text, init);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    // The session keeps one thing per identity itself: where they browse
    // from, saved under whoever's signed in as it's set.
    const ofStore = (text: string) => hooks.has(text.split(/[.(<]/)[0]) || /^useSession\b.*\bsetLocation\b/s.test(text);
    /// Whether `call` writes to a per-identity store.
    const writes = (call: ts.CallExpression): boolean => {
      const callee = call.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const target = callee.expression;
        const text = target.getText(source);
        // useCarts.setState(…), useCarts.getState().setCart(…)
        if (callee.name.text === "setState" && ofStore(text)) return true;
        if (ts.isCallExpression(target) && text.endsWith(".getState()") && ofStore(text)) return true;
        if (text === "useSession.getState()" && callee.name.text === "setLocation") return true;
        // const cart = useCart(…); cart.clear()
        if (ts.isIdentifier(target)) return ofStore(bound.get(target.text) ?? "");
        return false;
      }
      // const setName = useGuardianNames((s) => s.setName); setName(…)
      if (ts.isIdentifier(callee)) return ofStore(bound.get(callee.text) ?? "");
      return false;
    };
    const functionOf = (node: ts.Node): ts.SignatureDeclaration | undefined => {
      for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return at;
      return undefined;
    };
    /// Whether anything in `fn`, outside the functions nested in it, ending
    /// before `pos`, holds.
    const before = (fn: ts.Node, pos: number, holds: (n: ts.Node) => boolean): boolean => {
      let yes = false;
      const look = (n: ts.Node) => {
        if (yes || n.pos >= pos) return;
        if (n.end <= pos && holds(n)) yes = true;
        else if (!ts.isFunctionLike(n)) ts.forEachChild(n, look);
      };
      ts.forEachChild(fn, look);
      return yes;
    };
    const awaits = (n: ts.Node) => ts.isAwaitExpression(n) || (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "then");
    const takesCheck = (n: ts.Node) => ts.isCallExpression(n) && n.expression.getText(source) === "stillSignedIn";
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && writes(node)) {
        const fn = functionOf(node);
        if (fn && before(fn, node.getStart(source), awaits)) {
          // The check may be taken in this step or one it's nested in.
          let guarded = false;
          for (let at: ts.Node | undefined = fn; at && !guarded; at = functionOf(at)) guarded = before(at, node.getStart(source), takesCheck);
          if (!guarded) found.push({ file: file.slice(SRC.length), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.getText(source).slice(0, 80) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test("the stores kept per identity are found", () => {
  const hooks = perIdentityHooks();
  for (const hook of ["useCarts", "useCustomerSettings", "useDriverSettings", "useGuardianNames", "useSentBids", "useCarrying"]) assert.ok(hooks.has(hook), hook);
});

test("no step writes to one identity's store after an await without checking it's still theirs", () => {
  const found = unguardedWrites();
  assert.deepEqual(found, [], `take stillSignedIn() before the first await, and check it before these:\n${found.map((w) => `  src/${w.file}:${w.line}  ${w.text}`).join("\n")}`);
});
