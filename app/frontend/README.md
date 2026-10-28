# SongForge frontend

The Next.js app for SongForge. It is served on port 3333, bound to `0.0.0.0` so
other devices on your network can reach it, and proxies `/api` to the backend on
`127.0.0.1:3334` (see `next.config.ts`).

Do not start it by hand for normal use: `scripts\Start-SongForge.ps1` starts the
backend, this app and the local lyrics model together, waits for each to answer,
and prints the LAN address.

## Working on it

```powershell
npm install
npm run dev        # port 3333
npm run build      # production build; needed before `npm run start`
npm run start      # what the launcher runs
```

Checks, all of which should be clean before a change lands:

```powershell
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run smoke      # serves a stub API and requests every route
```

## Layout

- `src/app` - routes. `/` library, `/create`, `/lyrics`, `/learn`, `/settings`,
  `/song/[id]`.
- `src/components` - feature components; `ui/primitives.tsx` holds every shared
  control (hand-written, no component library).
- `src/lib` - `api.ts` (typed client), `types.ts` (hand-written mirrors of the
  backend schemas), `store.tsx` (one context, SSE job updates), plus the
  prompting helpers `style-tags.ts` and `lyrics-lint.ts`.
- Styling is Tailwind v4 with the `--sf-*` CSS variables defined in
  `src/app/globals.css`. There is no `tailwind.config`.

`AGENTS.md` in this folder is written by `next dev` and warns that this Next.js
version differs from older documentation; its bundled docs are in
`node_modules/next/dist/docs/`.
