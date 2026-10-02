# Waterways: guide for Claude sessions

Open-world game with a map editor. Laravel 13 studio (Inertia + React) serves a Three.js r186 game that renders
with `WebGPURenderer` and TSL node materials (WebGL 2 fallback). An MCP server lets agents build worlds.
Full details: README.md (features, architecture), docs/MCP.md (agent tools), docs/ROADMAP.md (phases),
docs/AUTONOMY.md (the local ↔ cloud change loop).

## Where things live

| Area                  | Path                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio pages          | `app/Http/Controllers/*`, `resources/js/pages/*` (React + shadcn/ui); routes via wayfinder (`resources/js/{actions,routes}`, generated)                                     |
| Game data API         | `app/Http/Controllers/Api/*` (manifest, binary assets, agent bridge)                                                                                                        |
| Terrain pipeline      | `app/Services/Terrain`, `app/Jobs/GenerateMapTerrain.php` (queued)                                                                                                          |
| Settings schemas      | `app/Support` (SettingField / Group, GameManifest, map templates)                                                                                                           |
| Game                  | `resources/game`: `core/` (loop, renderer, bridge, post-fx), `world/` (terrain, water, foliage, collision…), `player/`, `editor/`, `shared/` (types + postMessage protocol) |
| MCP server            | `app/Mcp/Servers/WaterwaysServer.php` (tool list + instructions), tools in `app/Mcp/Tools`, helpers in `app/Mcp`                                                            |
| Live agent commands   | PHP `App\Mcp\EditorBridge` queues → game `resources/game/core/AgentBridge.ts` / `AgentCommands.ts`, edits in `resources/game/editor/agent`                                  |
| Hidden editors        | `App\Mcp\HeadlessEditor` (+ `app/Mcp/Headless`), `php artisan waterways:headless`                                                                                           |
| Updates / engine loop | `App\Support\Updates\EngineUpdater` (`waterways:update`, `update_engine`), `EngineChanges` (`request_engine_change`)                                                        |
| Tests                 | PHP `tests/Feature`, `tests/Unit` (MCP tools via `WaterwaysServer::tool(...)`); JS `*.test.ts` next to the code (`vp test`)                                                 |

## Rules

- **UI ↔ MCP parity.** Anything added to the editor or studio ships with its MCP tool (or tool argument),
  tests and docs/MCP.md rows in the same change. Register new tools in `WaterwaysServer::$tools` and bump the
  count in `tests/Feature/Mcp/WaterwaysMcpTest::test_the_server_lists_every_tool_on_one_page`.
- **WebGPU texture budget:** a shader stage may sample at most 16 textures. Terrain and water shaders are at
  the limit; adding a texture means packing (atlases, shared channels) or freeing a slot. Check the comments in
  `world/water/*`, `world/bounce/BounceLight.ts` before touching them.
- Write shaders in TSL (`three/tsl`), not GLSL. Keep the WebGL 2 fallback working.
- Shell commands in PHP go through Laravel's `Process` facade, so tests can `Process::fake()`.
- Expected tool failures throw `App\Mcp\ToolError` (shown to the agent as a readable error).
- Docs: README feature sections, docs/MCP.md for tools, docs/ROADMAP.md phase table. Plain, short sentences.

## Checks (all must pass before a commit / PR)

```bash
npx tsc --noEmit -p .     # types (needs generated wayfinder files: npm run build once)
npx vp check --fix        # lint + format (vite-plus)
npm test                  # JS unit tests
vendor/bin/pint           # PHP style (CI runs --test)
php artisan test          # PHPUnit (feature tests need public/build: npm run build)
```

CI (`.github/workflows/ci.yml`) runs the same on PRs and pushes to main / `claude/**`.

## Seeing it run

- Local: `composer dev` (or Laravel Herd) and open the studio; the game page is `/game/{map}`.
- Headless (no GPU, e.g. a container): run Chromium with SwiftShader:
  `chromium --headless=new --use-angle=swiftshader --enable-unsafe-webgpu --enable-unsafe-swiftshader --window-size=1600,900 --screenshot http://localhost:8000/game/<map>`,
  or set `WATERWAYS_BROWSER_FLAGS="--use-angle=swiftshader --enable-unsafe-webgpu"` and use the MCP tools
  `open_editor` + `take_screenshot`. Expect low fps; check the console log for WebGPU validation errors
  (e.g. too many sampled textures).

## Commits

- Small, focused commits with a one-line imperative summary (`Area: what changed`), body when useful.
- No model names in code or commit messages. Never commit `.env`, `vendor/`, `node_modules/`, `public/build/`.
- Branches for cloud work: `claude/…` from main; open a PR using `.github/pull_request_template.md`.
