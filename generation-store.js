// Storage-neutral conflict used by both adapters. A conflict never rebases an
// already-fetched snapshot onto a different baseline.
export class GenerationConflict extends Error {}
