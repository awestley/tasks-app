export const LIMIT_DEFAULT: number;
export const LIMIT_MAX: number;
export const QUERY_MAX: number;
export interface SearchParams { q: string; terms: string[]; types: string[] | null; limit: number; cursor: string | null; updatedAfter: Date | null }
export function fold(s: unknown): string;
export function parseSearchParams(query?: Record<string, unknown>): { ok: true; params: SearchParams } | { ok: false; error: string };
export function scoreMatch(terms: string[], doc?: { title?: string; body?: string }): number;
export function makeSnippet(terms: string[], body: string, options?: { width?: number }): { text: string; highlights: [number, number][] } | null;
export function searchList<T>(items: T[], params: SearchParams, toDoc: (item: T) => Record<string, unknown>): { items: Record<string, unknown>[]; next_cursor: string | null };
