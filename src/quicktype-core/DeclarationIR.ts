import { List } from "immutable";

import { TypeGraph } from "./TypeGraph";
import { Type } from "./Type";
import { panic, defined } from "./support/Support";
import { Graph } from "./Graph";
import { messageError } from "./Messages";
import { setUnionInto, setFilter, iterableFirst, setSubtract, setIntersect } from "./support/Containers";

export type DeclarationKind = "forward" | "define";

export interface Declaration {
    readonly kind: DeclarationKind;
    readonly type: Type;
}

export class DeclarationIR {
    readonly declarations: ReadonlyArray<Declaration>;

    constructor(declarations: Iterable<Declaration>, readonly forwardedTypes: Set<Type>) {
        this.declarations = Array.from(declarations);
    }
}

function findBreaker(t: Type, path: List<Type>, canBreak: ((t: Type) => boolean) | undefined): Type | undefined {
    const index = path.indexOf(t);
    if (index < 0) return undefined;
    if (canBreak === undefined) {
        return path.get(index);
    }
    const potentialBreakers = path.take(index + 1).reverse();
    const maybeBreaker = potentialBreakers.find(canBreak);
    if (maybeBreaker === undefined) {
        return panic("Found a cycle that cannot be broken");
    }
    return maybeBreaker;
}

export function cycleBreakerTypesForGraph(
    graph: TypeGraph,
    isImplicitCycleBreaker: (t: Type) => boolean,
    canBreakCycles: (t: Type) => boolean
): Set<Type> {
    const visitedTypes = new Set<Type>();
    const cycleBreakerTypes = new Set<Type>();
    const queue: Type[] = graph.topLevels.valueSeq().toArray();

    // FIXME: We never push anything onto the path.  How can this
    // be correct?
    function visit(t: Type, path: List<Type>): void {
        if (visitedTypes.has(t)) return;

        if (isImplicitCycleBreaker(t)) {
            for (const c of t.getChildren()) {
                queue.push(c);
            }
        } else {
            const maybeBreaker = findBreaker(t, path, canBreakCycles);
            if (maybeBreaker !== undefined) {
                cycleBreakerTypes.add(maybeBreaker);
                return;
            }

            const pathForChildren = path.unshift(t);
            t.getChildren().forEach(c => visit(c, pathForChildren));
        }

        visitedTypes.add(t);
    }

    for (;;) {
        const maybeType = queue.pop();
        if (maybeType === undefined) break;
        visit(maybeType, List());
    }

    return cycleBreakerTypes;
}

export function declarationsForGraph(
    typeGraph: TypeGraph,
    canBeForwardDeclared: ((t: Type) => boolean) | undefined,
    childrenOfType: (t: Type) => ReadonlySet<Type>,
    needsDeclaration: (t: Type) => boolean
): DeclarationIR {
    /*
    function nodeTitle(t: Type): string {
        const indexAndKind = `${t.typeRef.index} ${t.kind}`;
        if (t.hasNames) {
            return `${indexAndKind} ${t.getCombinedName()}`;
        } else {
            return indexAndKind;
        }
    }
    function componentName(c: Iterable<Type>): string {
        return Array.from(c).map(nodeTitle).join(", ");
    }
    */

    const topDown = canBeForwardDeclared === undefined;
    const declarations: Declaration[] = [];
    const forwardedTypes = new Set<Type>();
    const visitedComponents = new Set<ReadonlySet<Type>>();

    function processGraph(graph: Graph<Type>, _writeComponents: boolean): void {
        const componentsGraph = graph.stronglyConnectedComponents();
        function visitComponent(component: ReadonlySet<Type>): void {
            if (visitedComponents.has(component)) return;
            visitedComponents.add(component);

            // console.log(`visiting component ${componentName(component)}`);

            const declarationNeeded = setFilter(component, needsDeclaration);

            // 1. Only one node in the cycle needs a declaration, in which
            // case it's the breaker, and no forward declaration is necessary.
            if (declarationNeeded.size === 1) {
                declarations.push({ kind: "define", type: defined(iterableFirst(declarationNeeded)) });
                return;
            }

            // 2. No node in the cycle needs a declaration, but it's also
            // the only node, so we don't actually need a declaration at all.
            if (declarationNeeded.size === 0 && component.size === 1) {
                return;
            }

            // 3. No node in the cycle needs a declaration, but there's more.
            // than one node total.  We have to pick a node to make a
            // declaration, so we can pick any one. This is not a forward
            // declaration, either.
            if (declarationNeeded.size === 0) {
                declarations.push({ kind: "define", type: defined(iterableFirst(component)) });
                return;
            }

            // 4. More than one node needs a declaration, and we don't need
            // forward declarations.  Just declare all of them and be done
            // with it.
            if (canBeForwardDeclared === undefined) {
                declarationNeeded.forEach(t => {
                    declarations.push({ kind: "define", type: t });
                });
                return;
            }

            // 5. More than one node needs a declaration, and we have
            // to make forward declarations.  We do the simple thing and first
            // forward-declare all forward-declarable types in the SCC.  If
            // there are none, we're stuck.  If there are, we take them out of
            // the component and try the whole thing again recursively.  Then
            // we declare the types we previously forward-declared.
            const forwardDeclarable = setFilter(component, canBeForwardDeclared);
            if (forwardDeclarable.size === 0) {
                return messageError("IRNoForwardDeclarableTypeInCycle", {});
            }
            forwardDeclarable.forEach(t => {
                declarations.push({ kind: "forward", type: t });
            });
            setUnionInto(forwardedTypes, forwardDeclarable);
            const rest = setSubtract(component, forwardDeclarable);
            const restGraph = new Graph(rest, true, t => setIntersect(childrenOfType(t), rest));
            processGraph(restGraph, false);
            forwardDeclarable.forEach(t => {
                declarations.push({ kind: "define", type: t });
            });
            return;
        }

        /*
        if (_writeComponents) {
            componentsGraph.nodes.forEach(types => {
                console.log(
                    `scc: ${types
                        .filter(t => t instanceof ClassType)
                        .map(t => t.getCombinedName())
                        .join(", ")}`
                );
            });
        }
        */

        const rootsUnordered = componentsGraph.findRoots();
        const roots = rootsUnordered;
        roots.forEach(component => {
            componentsGraph.dfsTraversal(component, topDown, visitComponent);
        });
    }

    const fullGraph = typeGraph.makeGraph(false, childrenOfType);
    // fs.writeFileSync("graph.dot", fullGraph.makeDot(t => !(t instanceof PrimitiveType), nodeTitle));
    processGraph(fullGraph, true);

    return new DeclarationIR(declarations, forwardedTypes);
}
