import type { SessionTreeNode } from "../../../core/session-manager.ts";

/** Gutter position and continuation state for an ancestor branch. */
export interface GutterInfo {
	position: number;
	show: boolean;
}

/** A tree node with display indentation and connector metadata. */
export interface FlatNode {
	node: SessionTreeNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: GutterInfo[];
	isVirtualRootChild: boolean;
}

export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}
export function flattenSessionTree(
	roots: SessionTreeNode[],
	currentLeafId: string | null,
): { nodes: FlatNode[]; toolCallMap: Map<string, ToolCallInfo>; multipleRoots: boolean } {
	const result: FlatNode[] = [];
	const toolCallMap = new Map<string, ToolCallInfo>();

	// Indentation rules:
	// - At indent 0: stay at 0 unless parent has >1 children (then +1)
	// - At indent 1: children always go to indent 2 (visual grouping of subtree)
	// - At indent 2+: stay flat for single-child chains, +1 only if parent branches

	// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
	type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
	const stack: StackItem[] = [];

	// Determine which subtrees contain the active leaf (to sort current branch first)
	// Use iterative post-order traversal to avoid stack overflow
	const containsActive = new Map<SessionTreeNode, boolean>();
	const leafId = currentLeafId;
	{
		// Build list in pre-order, then process in reverse for post-order effect
		const allNodes: SessionTreeNode[] = [];
		const preOrderStack: SessionTreeNode[] = [...roots];
		while (preOrderStack.length > 0) {
			const node = preOrderStack.pop()!;
			allNodes.push(node);
			// Push children in reverse so they're processed left-to-right
			for (let i = node.children.length - 1; i >= 0; i--) {
				preOrderStack.push(node.children[i]);
			}
		}
		// Process in reverse (post-order): children before parents
		for (let i = allNodes.length - 1; i >= 0; i--) {
			const node = allNodes[i];
			let has = leafId !== null && node.entry.id === leafId;
			for (const child of node.children) {
				if (containsActive.get(child)) {
					has = true;
				}
			}
			containsActive.set(node, has);
		}
	}

	// Add roots in reverse order, prioritizing the one containing the active leaf
	// If multiple roots, treat them as children of a virtual root that branches
	const multipleRoots = roots.length > 1;
	const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		const isLast = i === orderedRoots.length - 1;
		stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
	}

	while (stack.length > 0) {
		const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

		// Extract tool calls from assistant messages for later lookup
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = (entry.message as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
						const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
						toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
					}
				}
			}
		}

		result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

		const children = node.children;
		const multipleChildren = children.length > 1;

		// Order children so the branch containing the active leaf comes first
		const orderedChildren = (() => {
			const prioritized: SessionTreeNode[] = [];
			const rest: SessionTreeNode[] = [];
			for (const child of children) {
				if (containsActive.get(child)) {
					prioritized.push(child);
				} else {
					rest.push(child);
				}
			}
			return [...prioritized, ...rest];
		})();

		// Calculate child indent
		let childIndent: number;
		if (multipleChildren) {
			// Parent branches: children get +1
			childIndent = indent + 1;
		} else if (justBranched && indent > 0) {
			// First generation after a branch: +1 for visual grouping
			childIndent = indent + 1;
		} else {
			// Single-child chain: stay flat
			childIndent = indent;
		}

		// Build gutters for children
		// If this node showed a connector, add a gutter entry for descendants
		// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		// When connector is displayed, add a gutter entry at the connector's position
		// Connector is at position (displayIndent - 1), so gutter should be there too
		const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const childGutters: GutterInfo[] = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;

		// Add children in reverse order
		for (let i = orderedChildren.length - 1; i >= 0; i--) {
			const childIsLast = i === orderedChildren.length - 1;
			stack.push([
				orderedChildren[i],
				childIndent,
				multipleChildren,
				multipleChildren,
				childIsLast,
				childGutters,
				false,
			]);
		}
	}

	return { nodes: result, toolCallMap, multipleRoots };
}
