/** Validate model-supplied upsert arguments before calculating any embeddings. */
export function parseMemoryUpsertArguments(args: Record<string, unknown> | undefined): {
  description: string;
  entityIds: number[];
  newEntities: Array<{ name: string; type: string }>;
  replacesFactId?: number;
  expectedDescription?: string;
} {
  if (!args) throw new Error('Missing tool arguments. Supply description and entityIds.');
  if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > 4000) {
    throw new Error('Missing or invalid description. Put the NEW complete corrected fact in description. For an update, expectedDescription must instead be the exact OLD description returned by search_memory; do not put the new text in expectedDescription.');
  }
  if (!Array.isArray(args.entityIds) || args.entityIds.length > 20 || !args.entityIds.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('entityIds must be an array of existing positive entity IDs returned by search_memory; use [] when providing newEntities.');
  }
  const newEntities = args.newEntities === undefined ? [] : args.newEntities;
  if (!Array.isArray(newEntities) || newEntities.length > 20 || !newEntities.every(e => e && typeof e === 'object' && typeof e.name === 'string' && e.name.trim() && e.name.length <= 256 && ['person', 'org', 'location', 'thing', 'event'].includes(e.type)) || args.entityIds.length + newEntities.length === 0) {
    throw new Error('Provide at least one valid existing entity ID or a new entity with name and type.');
  }
  if ((args.replacesFactId !== undefined || args.expectedDescription !== undefined) && (!Number.isSafeInteger(args.replacesFactId) || (args.replacesFactId as number) <= 0 || typeof args.expectedDescription !== 'string' || !args.expectedDescription.trim())) {
    throw new Error('For an update, provide both replacesFactId and expectedDescription: copy the ID and exact OLD description from search_memory. Put the NEW fact in description.');
  }
  return { description: args.description.trim(), entityIds: args.entityIds as number[], newEntities: newEntities as Array<{ name: string; type: string }>, ...(args.replacesFactId !== undefined ? { replacesFactId: args.replacesFactId as number, expectedDescription: args.expectedDescription as string } : {}) };
}
