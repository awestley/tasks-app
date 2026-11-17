export interface Ref { app: string; type: string; id: string }
export interface ShortRef { index: number; length: number; embed: boolean; ref: string; label: string | null }
export function parseRef(ref: unknown): Ref | null;
export function formatRef(ref: Ref): string;
export function findShortRefs(markdown: string, typeOwners: Record<string, string>): ShortRef[];
export function shortRef(ref: string, options?: { embed?: boolean; label?: string }): string;
