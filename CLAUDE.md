# Trip Agent (SolAgent) project notes

## Rules
- Node >= 22.13 (uses built-in `node:sqlite`). Monorepo: `packages/*` (shared, planner, booking, api) and `apps/web`.
- TypeScript imports keep their `.ts`/`.tsx` extensions.
- The web app uses `import type` only from `@solagent/*`; runtime imports would pull `node:crypto` into the browser.
- Every trip mutation in `TripService` must end in `emit()`, which persists it.
- Money is integer cents everywhere. Format with `formatUsd` in `apps/web/src/lib/format.ts`.
- The wallet screen is a demo (localStorage). Don't present it as real money.

## Web design system (apps/web/src/styles.css)
- Brand: teal stage `#077a90`, yellow `#f3c11b`, ink `#052a33`, pale ticket `#fff7db`, grey rail `#d9e4e6`.
- Type: Bricolage Grotesque for headings and numbers, Hanken Grotesk for body.
- Motifs: yellow ribbon title per screen, ticket cards with an IATA-code stub, route-line budget bar (paid solid, planned striped, cap marker, coral when over).
- White text only on `--teal`, `--teal-700`, `--teal-800`, `--ink`, `--green`, `--red`. Use ink on yellow and paper.
- Copy: sentence case, plain verbs, buttons say what they do, errors say how to fix it.
- Keep 44px touch targets, visible focus, and the layout working down to 360px.
