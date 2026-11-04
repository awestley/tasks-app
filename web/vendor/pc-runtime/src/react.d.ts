import type { ReactNode, ReactElement } from 'react';
import type { ApplyTheme, Command, PcClient, Theme } from './index.js';
export function PcProvider(props: { app: string; applyTheme?: ApplyTheme; children?: ReactNode }): ReactElement;
export function usePc(): PcClient;
export function useTheme(): Theme;
export function useHosted(): boolean;
export function usePaneTitle(title: string | null | undefined): void;
export function useCommands(commands: Command[], onCommand: (id: string) => void): void;
export function PcEmbed(props: { target: string; size?: 'inline' | 'card'; className?: string; children?: ReactNode }): ReactElement;
