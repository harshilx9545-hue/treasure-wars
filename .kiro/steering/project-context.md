# Bedwars Project Context

This file is the persistent architecture cache for this workspace. Reuse it instead of re-indexing the repository. Refresh it only when package boundaries, entry points, build configuration, or major subsystem ownership changes.

## Working Rule

For each bug or feature, inspect only the smallest relevant execution path. Start from the ownership map below, read direct callers/callees as needed, edit only affected files, run the narrowest available validation, then stop. Do not scan unrelated systems or rebuild a repository-wide dependency graph.

For performance work, profile first and follow only the measured bottleneck. For network work, start with `client/src/net.ts`, `server/src/rooms/GameRoom.ts`, `shared/src/messages.ts`, and directly involved networking utilities; do not inspect rendering unless evidence makes it part of the path. For weapon/rendering bugs, start with weapon models, attachment, animation, and player rendering; do not inspect AI, UI, networking, terrain, menus, or environment unless directly involved.

## Package and Dependency Map

This is an npm workspace monorepo defined by the root `package.json`:

```text
client (Vite + Three.js + colyseus.js) ──┐
                                        ├──> shared (source-only TypeScript)
server (Colyseus + Express + tsx) ──────┘
tools/export_pirate_assets.py ──> client/src/assets/pirate runtime GLBs
```

Dependency direction is `client -> shared` and `server -> shared`. `shared` does not depend on either runtime. Client and server do not import each other; they communicate through Colyseus using the shared protocol.

Bulk source assets live under directories such as `animation/`, `weapons/`, `glTF/`, `TREE/`, and `Textures/`. Treat those as asset inputs, not code architecture. Never index `node_modules/`, `.git/`, generated output such as `client/dist/`, caches, or bulk binary assets during normal investigation.

## Runtime Entry Points

- `client/index.html` loads `client/src/main.ts`.
- `client/src/main.ts` is the browser composition root. It creates graphics, world state/renderers, input, local prediction, remote players, HUD, particles, mining, first-person view model, menu/lobby/shop/objective/end screen, entities, treasure, environment, and pirate-asset preloading. It also owns room state and some message/event wiring; inspect only the relevant section when a traced path reaches it.
- `server/src/index.ts` creates Express health routes, initializes the Colyseus WebSocket transport, registers room type `bedwars`, and listens on `PORT` or `2567`.
- `server/src/rooms/GameRoom.ts` is the authoritative multiplayer room and simulation owner. It handles lifecycle, lobby options, shared messages, input queues, world diffs, movement/physics, combat, economy, entities, respawn, win state, bots, and the tick interval.
- `shared/src/index.ts` is the public shared barrel.

## Feature Ownership

### Shared deterministic game and protocol

- `shared/src/messages.ts`: message names and network payload/event types.
- `shared/src/constants.ts`: simulation and world constants.
- `shared/src/world.ts`: voxel storage and raycasting.
- `shared/src/map.ts`: deterministic map, spawn, and treasure generation.
- `shared/src/physics.ts`: shared player physics and collision used by prediction and authority.
- `shared/src/blocks.ts`, `teams.ts`: block/team definitions and bed helpers.
- `shared/src/weapons.ts`, `powerups.ts`, `economyConfig.ts`: gameplay catalogs and tuning.

Changes here may affect both client and server. Follow imports only for the specific symbol being changed.

### Client

- Composition/game loop/local prediction/message wiring: `client/src/main.ts`.
- Connection and room discovery/joining: `client/src/net.ts`, `client/src/lobby.ts`; follow into only the relevant room handler in `main.ts` if required.
- Graphics/world: `client/src/graphics.ts`, `worldRenderer.ts`, `atlas.ts`.
- Player input and presentation: `client/src/input.ts`, `remotePlayers.ts`, `viewModel.ts`, `mining.ts`.
- Weapon and pirate visuals: `client/src/weaponModels.ts`, `animationController.ts`, `pirateAssetCache.ts`, `piratePreloader.ts`, and generated assets below `client/src/assets/pirate/`.
- Entities/effects: `client/src/entities.ts`, `particles.ts`, `treasure.ts`.
- Client-only scenery: `client/src/environment.ts`.
- UI flows: `client/src/ui.ts`, `menu.ts`, `lobby.ts`, `shop.ts`, `objective.ts`, `endscreen.ts`, `settings.ts`, `audio.ts`, and `menu-theme.css`.

### Server

- Process/transport bootstrap: `server/src/index.ts`.
- Authoritative room/gameplay/network handlers: `server/src/rooms/GameRoom.ts`.
- Replicated Colyseus schema: `server/src/schema/GameState.ts`.
- Bot behavior only: `server/src/bots/BotController.ts`; inspect it only for bot-specific behavior or when a traced `GameRoom` callback directly implicates it.

### Asset Pipeline

- `tools/export_pirate_assets.py` is a Blender Python exporter using `bpy`/`mathutils`.
- It reads pirate source blends/animations, classifies character and weapon content, converts materials, and emits self-contained GLBs beneath `client/src/assets/pirate/characters`, `weapons`, and `animations`.
- For exporter bugs, inspect this tool plus only the named source/output asset paths and the matching client loader; do not scan gameplay systems.

## Build and Validation

Authoritative root commands:

- Client type-check and production build: `npm run build` (equivalent to `npm run build:client`).
- Server one-shot start: `npm run start:server`; this is a long-running process and is not a build check.
- Client/server development scripts are long-running and must not be used as validation commands.

The client build runs `tsc --noEmit` followed by `vite build`. The server runs TypeScript directly through `tsx`; it has no compile/build script. No repository test, lint, or format script was present when this cache was created. For future fixes, run targeted tests if they are added; otherwise run the client build for client/shared changes and a bounded server smoke/type check appropriate to the affected path. Do not add tests unless explicitly requested.

## Cache Invalidation

Do not rescan the project for ordinary source edits. Update only the affected section of this cache if one of these changes:

- root/workspace manifests or TypeScript/Vite configuration change package boundaries;
- a runtime entry point moves;
- a major subsystem is added, removed, or changes owner;
- shared dependency direction or protocol boundaries change;
- build/test commands change.

When none of those conditions applies, assume this architecture remains valid and investigate incrementally.