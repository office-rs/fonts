// Ambient declarations shipped at the package root (loaded via the "./vite" export's
// types entry). This file is a global script on purpose: `declare module` blocks here
// are ambient, so both the virtual module and the subpath itself resolve for consumers.
declare module 'virtual:rword-fonts' { export const manifestUrl: string; }

declare module '@office-rs/font-runtime/vite' {
  import type { Plugin } from 'vite';
  export interface RwordFontsOptions { families: string[]; }
  export default function rwordFonts(opts: RwordFontsOptions): Plugin;
}
