# Host detail fixture evidence

These screenshots use generic fixture host identifiers and example session metadata.
They come from an isolated headless Chrome with no installed host data or credentials.
Desktop is 1440 × 1000; phone is 390 × 844. Full-page captures include content below the viewport.

| Layout | Desktop | Phone |
| --- | --- | --- |
| Before: sessions selected, resources hidden in a separate tab | [Before desktop](before-desktop.png) | [Before phone](before-phone.png) |
| After: resources pinned, sessions selected, disclosures expanded | [After desktop](after-desktop.png) | [After phone](after-phone.png) |
| After: current delegated Beszel metrics | [Beszel desktop](beszel-desktop.png) | [Beszel phone](beszel-phone.png) |

Reproduce the after captures with `npm run build`, then
`node scripts/accept-detail.ts <evidence-directory>` using the external
Playwright tool configured in DEVELOPMENT.md. The before captures were made
against the unchanged implementation using the same fixture and viewport sizes.
