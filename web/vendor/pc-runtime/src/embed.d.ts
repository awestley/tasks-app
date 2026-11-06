import type { PcClient } from './index.js';
export function loadManifest(appId: string, fetchImpl?: typeof fetch): Promise<Record<string, unknown>>;
export function embedTagFor(ref: string, options?: object): Promise<{ tag: string; manifest: Record<string, unknown>; parsed: { app: string; type: string; id: string } }>;
export function defineEmbed(pc: PcClient, options?: { name?: string }): void;
