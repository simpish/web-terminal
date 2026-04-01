# Vite + TypeScript Migration Plan

**Status:** Planning
**Created:** 2026-04-01

---

## 1. Architecture Decisions

### Module + Function (NOT Class)

Current codebase is procedural -- functions operating on shared global state. Classes would add ceremony with no benefit (no inheritance, no polymorphism, no multiple instances). The right pattern:

- **State store** (`state.ts`): single module exporting shared state
- **Feature modules**: exported functions, each importing from state and API client
- **Entry point** (`main.ts`): wires event listeners, calls init()

### No Heavy Framework

- **Astro is unnecessary** -- it's Vite-based itself, designed for content-heavy sites. Overkill for a single-page terminal UI
- **No React/Vue/Svelte** -- vanilla TypeScript with DOM manipulation is sufficient for this scale
- **CSS stays as-is** -- `index.css` with CSS variables and themes works well

### Server Stays as Node.js

- `server.js` remains CommonJS, zero npm runtime dependencies
- Only change: serve from `dist/` when it exists
- Future option: add JSDoc types or `// @ts-check` for IDE support

---

## 2. Target Directory Structure

```
web-terminal/
  src/
    main.ts              # Entry: imports modules, binds events, calls init()
    state.ts             # Shared app state (currentSession, currentPort, etc.)
    api.ts               # All fetch calls to /api/* (typed)
    types.ts             # Shared interfaces (Session, ApiResult, DirListing, etc.)
    modules/
      sidebar.ts         # Sidebar open/close
      sessions.ts        # Session CRUD + rename
      terminal.ts        # iframe load/reload/resession
      keys.ts            # Key button handling, setupBtnRow
      claude.ts          # Claude shortcuts, toggle row
      input.ts           # Textarea send/run/flush, auto-resize
      browser.ts         # File browser: navigate, render, cd, hidden toggle
      theme.ts           # Theme select, localStorage persistence
  index.html             # Vite entry HTML (<script src="/src/main.ts">)
  index.css              # No changes (imported from main.ts)
  server.js              # dist/ serving support added (3 lines)
  vite.config.ts         # Proxy /api/* to Node backend
  tsconfig.json
  package.json           # vite + typescript as devDependencies only
  dist/                  # Production build output (gitignored)
```

---

## 3. Module Design

### `src/types.ts`

```typescript
export interface Session { name: string; port: number | null; }
export interface ConnectResult { ok: boolean; port: number; host: string; }
export interface ApiResult { ok: boolean; error?: string; }
export interface RenameResult extends ApiResult { name?: string; port?: number; }
export interface DirListing { ok: boolean; path: string; dirs: string[]; files: string[]; error?: string; }
```

### `src/state.ts`

Centralized mutable state (replaces 8+ global variables):

- `currentSession: string | null`
- `currentPort: number | null`
- `currentTtydHost: string | null`
- `browserPath: string`
- `browserLoaded: boolean`
- `HOME_DIR: string`
- `showHidden: boolean`
- `browserMode: 'browse' | 'new-session'`
- `claudeRowLocked: boolean`

### `src/api.ts`

Every `fetch('/api/...')` call extracted into typed functions:

- `getSessions(): Promise<Session[]>`
- `createSession(name, cwd?): Promise<RenameResult>`
- `deleteSession(name): Promise<ApiResult>`
- `renameSession(oldName, newName): Promise<RenameResult>`
- `connect(session): Promise<ConnectResult>`
- `resession(session): Promise<ConnectResult>`
- `sendKeys(session, keys): Promise<ApiResult>`
- `sendText(session, text): Promise<ApiResult>`
- `sendLiteral(session, text): Promise<ApiResult>`
- `scroll(session, direction): Promise<ApiResult>`
- `listDir(path, showHidden): Promise<DirListing>`
- `getHome(): Promise<string>`

This eliminates ~50 duplicated fetch+JSON blocks.

### Feature Modules

Each module exports an `initXxx()` function called from `main.ts`:

| Module | Exports | Dependencies |
|--------|---------|-------------|
| `sidebar.ts` | `openSidebar()`, `closeSidebar()`, `initSidebar()` | -- (leaf) |
| `theme.ts` | `initTheme()` | -- (leaf) |
| `terminal.ts` | `loadTermFrame()`, `initTerminal()` | state |
| `input.ts` | `flushInput()`, `doSend()`, `doRun()`, `initInput()` | state, api |
| `keys.ts` | `setupBtnRow()`, `sendKey()`, `initKeys()` | state, api, input, sidebar |
| `claude.ts` | `toggleClaude()`, `insertClaudeCmd()`, `initClaude()` | -- |
| `sessions.ts` | `fetchSessions()`, `switchSession()`, `initSessions()` | state, api, terminal, sidebar |
| `browser.ts` | `browseTo()`, `initBrowser()` | state, api, sessions |

### `src/main.ts`

```typescript
import '../index.css'
import { initSidebar } from './modules/sidebar'
import { initSessions } from './modules/sessions'
import { initTerminal } from './modules/terminal'
import { initKeys } from './modules/keys'
import { initClaude } from './modules/claude'
import { initInput } from './modules/input'
import { initBrowser } from './modules/browser'
import { initTheme } from './modules/theme'

// Touch scroll prevention
document.addEventListener('touchmove', ...)

// Initialize all modules
initSidebar()
initTheme()
initKeys()
initClaude()
initInput()
initTerminal()
initBrowser()

// App init
async function init() { ... }
init()
```

---

## 4. Vite Configuration

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:7681',
        changeOrigin: true,
      },
    },
  },
})
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

---

## 5. Development Workflow (After Migration)

```bash
# Development (two terminals)
node server.js &          # API server on port 7681
npx vite                  # Frontend dev server on port 5173 (proxies /api to 7681)

# Production build
npx vite build            # Outputs to dist/
node server.js            # Serves dist/ + API
```

---

## 6. Migration Phases

### Phase 1: Scaffolding (no behavior changes)

- [ ] Create `package.json` with vite + typescript as devDependencies
- [ ] Create `tsconfig.json`
- [ ] Create `vite.config.ts` with proxy config
- [ ] Add `dist/` and `node_modules/` to `.gitignore`
- [ ] `npm install`

**Verify:** `node server.js` still works as before. Nothing changed functionally.

### Phase 2: Vite Entry Point

- [ ] Update `index.html`: `<script src="/index.js">` -> `<script type="module" src="/src/main.ts">`
- [ ] Remove `<link rel="stylesheet" href="/index.css">` (CSS imported from main.ts)
- [ ] Create `src/main.ts`: import CSS + copy entire index.js content (TS is superset of JS)

**Verify:** `npx vite` serves the app, `/api/*` proxies to `node server.js`.

### Phase 3: Extract Core Modules

- [ ] Create `src/types.ts` with all interfaces
- [ ] Create `src/state.ts` -- extract 8 global variables into typed state object
- [ ] Create `src/api.ts` -- extract all fetch calls into typed functions
- [ ] Update `src/main.ts` to import from state and api

**Verify:** App works identically, code is now modular.

### Phase 4: Extract Feature Modules (parallelizable)

- [ ] Extract `src/modules/sidebar.ts`
- [ ] Extract `src/modules/theme.ts`
- [ ] Extract `src/modules/terminal.ts`
- [ ] Extract `src/modules/input.ts`
- [ ] Extract `src/modules/keys.ts`
- [ ] Extract `src/modules/claude.ts`
- [ ] Extract `src/modules/sessions.ts` (includes rename)
- [ ] Extract `src/modules/browser.ts`

**Verify:** Test after each extraction. Each module is independent.

### Phase 5: Strict Type Safety

- [ ] Enable `strict: true` (should already be set)
- [ ] Add proper DOM type assertions (`as HTMLButtonElement`, etc.)
- [ ] Create typed `$()` helper for DOM queries
- [ ] Remove all remaining `any` types
- [ ] Run `npx tsc --noEmit` to verify

### Phase 6: Production Wiring

- [ ] Update `server.js`: prefer `dist/` for static serving (3-line change)
- [ ] Add `package.json` scripts: `"dev": "vite"`, `"build": "vite build"`
- [ ] Optionally update `install.sh` with build guard
- [ ] Update `CLAUDE.md` with new dev workflow
- [ ] Delete original `index.js` (fully replaced by `src/`)

---

## 7. server.js Changes (Minimal)

```javascript
// Add at top of static file section:
const STATIC_ROOT = fs.existsSync(path.join(__dirname, 'dist', 'index.html'))
  ? path.join(__dirname, 'dist')
  : __dirname;

// Replace __dirname with STATIC_ROOT in static file serving:
// path.join(__dirname, safePath) -> path.join(STATIC_ROOT, safePath)
// filePath.startsWith(__dirname) -> filePath.startsWith(STATIC_ROOT)
```

Fallback: if `dist/` doesn't exist, serves from project root (backward compatible).

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking `node server.js` production flow | 3-line change with fallback to project root |
| Vite proxy missing API routes | Simple `/api` prefix match covers all 13 routes |
| ttyd iframe URLs bypass Vite | Correct -- direct connection to ttyd ports, no change needed |
| TS strictness surfacing bugs | Start permissive in Phase 2, enable strict in Phase 5 |
| CSS import order issues | Single CSS file, deterministic Vite handling |
| install.sh breaks | `server.js` path unchanged; optional build guard for `dist/` |

---

## 9. What NOT to Do

- **No state management library** (Zustand etc.) -- plain object in `state.ts` is sufficient
- **No CSS framework/modules** -- existing CSS variables work well
- **No server.js ESM/TS conversion** -- separate concern, future task
- **No server bundler** -- Vite is frontend-only
- **No Astro** -- overhead with no benefit for single-page app
