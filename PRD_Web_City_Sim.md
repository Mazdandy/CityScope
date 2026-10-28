# PRD — Web City Simulator ("CityScope")

**Version:** 1.1 — consolidated
**Date:** 2026-10-28
**Type:** Browser-based city-building simulation (Cities: Skylines-like)
**Deliverable:** Playable web game, static hosting, no backend required for v1

> **Single source of truth.** This file merges three documents that existed separately until 2026-10-28: the product spec (**§1–§13**), the closed Track A performance spike (**§14**) and the active M0 phase plan (**§15**).
>
> **Also on 2026-10-28:** the throwaway `spike/` app was deleted, and the production app was hoisted out of `cityscope/` to the repository root. The repository now holds exactly one app plus this document.

---

## 1. Vision

A city-building simulation that runs entirely in the browser: the player lays roads, zones districts, and watches a living city grow — traffic jams, power shortages, unhappy citizens and all. The core promise is **Cities: Skylines depth on a web build budget**: a real agent-based traffic simulation, a working RCI demand economy, and service coverage pressure — packaged in a single-page app that loads in under 10 seconds and runs at 60 FPS on a mid-range laptop.

**One-line pitch:** *Zone it, road it, watch it live — a full city sim in a browser tab.*

---

## 2. Goals & Non-goals

### 2.1 Goals (v1)
| # | Goal | Success signal |
|---|------|----------------|
| G1 | Feel like a real city sim, not a toy | Agents visibly commute to jobs; jams form and clear with player action |
| G2 | Instant on-ramp | First road placed within 60s of page load; no tutorial wall |
| G3 | Stable performance at scale | 60 FPS @ 5,000 citizens, 30+ FPS @ 50,000 citizens on mid-tier laptop |
| G4 | Zero infrastructure cost | Fully static; deployable to GitHub Pages / any CDN |
| G5 | Data safety | City survives browser refresh and tab close (local save) |

### 2.2 Non-goals (v1 — explicitly out of scope)
- Multiplayer / cloud sync / accounts
- User mods, custom asset import, Steam Workshop-style sharing
- Full 3D first-person / walk-mode camera
- Realistic hydrology, water physics, terrain sculpting beyond basic raise/lower
- Mobile-optimized UI (touch support is best-effort only)
- Monetization systems
- Small (256×256) and Large (1024×1024) map sizes — Standard 512 only at launch (§13 Q2)
- Public save/city sharing service — local file export only (§13 Q4)
- Guided first-city scenario or scripted tutorial campaign — sandbox only (§13 Q3)

---

## 3. Target Users

| Persona | Description | Primary need |
|---------|-------------|--------------|
| **The Tinkerer** (primary) | 18–35, played SimCity/Cities: Skylines, no gaming PC right now | Deep systems, spreadsheets-with-graphics |
| **The Lunchbreak Builder** | Plays in short sessions on a work laptop | Fast load, instant save, no install |
| **The Casual Watcher** | Likes growth/idle visuals, minimal micromanagement | Pretty city, gentle difficulty, clear feedback |

**Assumed baseline:** desktop browser (Chrome/Edge/Firefox/Safari), pointer + keyboard, WebGL2 capable, ≥4 GB RAM. The floor is deliberately low — see §13 Q5 — so the 2D isometric renderer (§4) is chosen for headroom, not just aesthetics.

---

## 4. Platform & Technical Constraints

| Constraint | Decision | Rationale |
|---|---|---|
| Runtime | Browser only, WebGL2 — **no Canvas2D fallback** (§14.7 closed 2026-10-28). Unsupported browsers get a clear screen, not a second renderer | Ubiquity, no install |
| Hosting | Static files, no server logic | GitHub Pages / Netlify free tiers, per user's stack preference |
| Persistence | IndexedDB (structured clone + compression) | Large saves (10–50 MB) exceed localStorage limits |
| Framework | Minimal — TypeScript + Vite, no heavy UI framework | Matches user's vanilla-first preference; small bundle |
| Rendering | **2D isometric on PixiJS, WebGL2 batched sprites** (decided — see §13 Q1) | Runs on weak/old hardware; no 3D asset cost; fastest path to delivery |
| Camera | Fixed 2:1 isometric plane, 90° rotation steps, zoom in discrete tile-scale steps | Classic city-sim readability; no projection maths |
| Fallback rendering | **None** — feature-detect WebGL2 at boot and show an unsupported-browser screen (§16 T8) | §14.7 asked for a Canvas2D blitter *only if* it held ≥ 30 FPS in A2; the spike was deleted unmeasured, and M0's own chunk-strategy pick (`cached` RenderTextures) would not survive a Canvas2D path anyway. Decided 2026-10-28 |
| Minimum target device | **Old 4 GB budget laptop** (dual-core x86, integrated GPU, 4 GB RAM, Chrome/Firefox, WebGL2) — the gaming-PC-less player (§13 Q5) | Sets the 30 FPS floor used in every perf budget |
| Offline | Playable after first load (service worker cache) | Supported by static hosting |
| Bundle budget | ≤ 2 MB gzipped initial JS, ≤ 4 MB total incl. assets | <10s load on 20 Mbps |

---

## 5. Gameplay Pillars

1. **Build** — Place roads, zones, and service buildings on a grid terrain.
2. **Simulate** — Agents (citizens, vehicles) travel a real graph; the city reacts to bottleneck and coverage.
3. **Balance** — Taxes, service budgets, and demand push the player toward trade-offs.
4. **Watch** — Read the city through overlays (traffic, land value, pollution, power, water…).

Every feature must serve at least one pillar. Features serving none are cut.

---

## 6. Feature Specification

Priority legend: **P0** = v1 required · **P1** = v1 stretch, cut first · **P2** = post-launch

### 6.1 Terrain & Map (P0)
- Procedurally generated map: heightmap (value noise / fBm), biome mix (grass, sand, rock, forest), sea level with water plane.
- Map sizes: **Standard 512×512 tiles is the only v1 size** (§13 Q2); Small 256 and Large 1024 are post-launch (P2).
- Tile size: **8 m** for zoning grid, roads occupy 2 tiles wide (16 m).
- Chunked storage: **32×32 tiles per chunk**; one sprite-layer set per chunk, culled against the camera rect.
- Terrain tools (P0): flatten, raise/lower, water placement (basic).
- **Acceptance:** Generate a random map in <3s; pan across the full 262k-tile map at 30 FPS on the minimum target device.

### 6.2 Camera & Controls (P0)
- Free pan (MMB drag / WASD / arrow keys / edge scroll) across the isometric plane; zoom in discrete tile-scale steps (wheel); rotate in 90° steps (Q/E).
- Camera anchor snaps to tile centres; zoom and pan clamp to the map bounds so the view never leaves terrain.
- Hotkeys: 1–9 tool bars, Space = pause/play, Tab = cycle overlays, Esc = cancel tool, Ctrl+S = save.
- **Acceptance:** All camera actions reachable without a mouse; input latency < 16 ms.

### 6.3 Roads & Network (P0 — the core hook)
- Road types: 2-lane street, 4-lane avenue, one-way street, highway (P1), roundabout piece (P1).
- Spline/segment-based placement with snapping, curvature preview, and drag-to-extend.
- Auto-generated intersections with turn lanes (visual simplification allowed) and traffic-light control.
- Bulldoze with refund %; upgrade/downgrade road classes in place.
- **Acceptance:** Build a 4-way intersection in <10s; vehicles path through it and queue realistically.

### 6.4 Zoning (P0)
- Growable zones painted as swaths: Residential (low/high density), Commercial (low/high), Industrial/Office.
- Zone cells auto-fill with procedurally assembled buildings as demand and land value allow.
- Level-up mechanic: buildings upgrade (1→5) with land value, education, service coverage.
- Abandonment/burn-down on sustained failure (no power, no buyers, high crime).
- **Acceptance:** Paint a residential zone next to roads with power → buildings appear within one in-game day.

### 6.5 Agents & Traffic Simulation (P0 — highest risk, highest value)
- Agent types: pedestrians, personal cars, buses (P1), trucks (freight, P1).
- Travel model: A* / hierarchical pathfinding over road graph; household "schedule" drives trips (home → work → shop → home).
- Congestion: per-segment density slows agents; congestion overlay derived from measured throughput.
- Agent budget: simulate up to **10,000 active vehicles**; beyond that, switch to statistical flow approximation (P1) — see §11 R2. Agents render as 8-frame sprite animations, degrading to 1-frame dots at far zoom (§7).
- **Acceptance:** Visible jam on a single connection road carrying 2,000+ commuters; adding a parallel road measurably reduces average trip time.

### 6.6 Services & Utilities (P0 subset)
| Service | v1 | Behaviour |
|---|---|---|
| Power | P0 | Plant capacity vs. city draw; brownouts propagate along grid; power-line tool |
| Water & Sewage | P0 | Pump capacity, pipe coverage radius; no service = buildings stall |
| Garbage | P1 | Landfill capacity + truck collection rounds |
| Health / Fire / Police | P1 | Coverage radius from service buildings; budget-driven vehicle count |
| Education | P1 | Schools raise education level → industry upgrade eligibility |
| Parks & Recreation | P1 | Land value + happiness boost |

- Coverage visualized as radius/heat overlays.
- **Acceptance:** Cutting the power budget to 0 visibly degrades the city within one in-game day.

### 6.7 Economy & Budget (P0)
- Monthly tick: income (taxes by zone type, fees) vs. expense (service budgets, road maintenance, loans).
- Adjustable tax rates per zone with demand elasticity (too high → abandonment/out-migration).
- Budget sliders per service (50–150 % of default) affecting coverage quality.
- Loans (P1), bailouts (P1), milestones that raise the loan ceiling.
- UI: income/expense breakdown, 12-month trend graph.
- **Acceptance:** Player can go bankrupt and recover; no infinite money exploit in first 3 hours.

### 6.8 Population & Demand (P0)
- RCI demand bars driven by: available jobs, residential capacity, land value, taxes, happiness.
- Milestones (population thresholds) unlock districts, road tiers, services, map size.
- Citizen happiness → city-wide approval rating affecting re-election-free "score" and demand.
- **Acceptance:** Demand bars respond to player action within one in-game hour.

### 6.9 Time, Weather & Day/Night (P1)
- In-game clock, speed controls: pause / 1× / 2× / 3×; offline "catch-up" is **not** simulated (anti-idle-exploit).
- Day/night cycle with light traffic/schedule variation.
- Weather (rain/snow/fog) affecting traffic speed and power draw; seasons (P2).

### 6.10 Overlays / Info Views (P0)
Traffic, demand/RCI, land value, pollution, noise, power, water, coverage (fire/police/health/education), happiness, zoning. One hotkey each; Tab cycles.

### 6.11 UI/UX (P0)
- HUD: money, population, date, speed, demand bars, notification badge.
- Notification system with severity (info/warning/crisis) and click-to-locate.
- Build tool palette with cost preview, ghost preview, and rotation.
- Screenshot mode (hide UI) — shareable city shots (P1).
- **Acceptance:** Any critical city problem is discoverable via notification within 5s of occurring.

### 6.12 Save / Load (P0)
- Auto-save every 5 in-game minutes to IndexedDB; 3 rotating slots + manual named slots.
- Export/Import save as `.cityscope` file (JSON + gzip or CBOR) — local file in/out between browsers only, no public sharing service (§13 Q4).
- Versioned save schema with migrations.
- **Acceptance:** Reload after browser crash restores within 2s with identical simulation state.

### 6.13 Audio (P1)
- Ambient city bed, UI clicks, construction, horn siren cues; music optional. All royalty-free/licensed for web.

---

## 7. Technical Architecture

```
┌─────────────────────────── Main Thread ───────────────────────────┐
│  UI Layer (DOM HUD, panels)  │  Renderer (PixiJS, WebGL2 sprites)  │
│      ▲ events / state        │      ▲ render state snapshots       │
├──────────────────────────────┴───────────────────────────────────┤
│                    Game State Store (typed arrays)                │
│         tiles · zones · buildings · road graph · agents           │
└──────────────────────────────┬───────────────────────────────────┘
                               │ postMessage (SharedArrayBuffer if COOP/COEP)
┌──────────────────────────────┴───────────────────────────────────┐
│                      Simulation Worker(s)                         │
│  Sim tick loop (8 Hz)  ·  Pathfinding pool  ·  Agent stepping      │
└──────────────────────────────────────────────────────────────────┘
```

**Key decisions**
- **Fixed sim tick at 8 Hz** for the economy/agent layer; render at rAF (up to 60 FPS) with interpolation. Decouples sim cost from render.
- **Typed-array SoA layout** for tiles/agents (flat `Float32Array` / `Int32Array`), no per-entity JS objects in hot loops.
- **Sim in Web Worker(s)**: 1 worker for pathfinding pool (P1: N workers), main thread only renders.
- **Batched sprite rendering (2D isometric)**: every visual is a sprite from a handful of texture atlases, drawn as fixed 2:1 iso diamonds; PixiJS batches by chunk + layer (terrain → roads → buildings → agents → overlays). No 3D meshes anywhere.
- **Modular sprite kit**: buildings are composited from base/mid/roof/prop sprites into cached atlas frames at import time → tiny asset budget, high visual variety, one batch group per chunk layer.
- **Road graph**: node/edge arrays with lane offsets; pathfinding via A* on edge graph with hierarchical contraction (P1) for long trips.
- **Save format**: versioned JSON with typed-array chunks base64/compressed; IndexedDB object store.
- **No backend.** Save portability is local file export/import only (§6.12) — no sharing service in v1 (§13 Q4).

**Performance budgets**
| Metric | Target |
|---|---|
| Frame time (minimum target device) | ≤ 33 ms (30 FPS) @ 5k citizens, Med preset |
| Frame time (mid-tier laptop) | ≤ 16 ms (60 FPS) @ 5k citizens |
| Draw calls | ≤ 150 PixiJS batch groups |
| Sim tick cost | ≤ 60 ms for 10k agents (8 Hz ⇒ 480 ms/s budget) |
| Initial load (cold) | ≤ 10 s on 20 Mbps |
| Memory | ≤ 1 GB at Standard 512 map, 50k citizens |
| Save size | ≤ 15 MB typical, ≤ 50 MB max |

> **These budgets are still unvalidated.** Nothing has been measured on any device yet — see §14 (spike, closed unmeasured) and §15 (M0, which now carries the whole performance verdict).

---

## 8. Data Model (indicative)

```ts
type Tile = { height: f32; terrain: u8; zone: u8; buildingId: i32; flags: u16 }
type Building = { id; type; level; pos; rot; householdCount?; jobs?; upkeep; powerDraw; waterDraw }
type RoadNode = { id; x; z; flags; connections: i32[] }
type RoadEdge = { from; to; lanesFwd; lanesBack; speedLimit; density; roadClass }
type Agent = { id; kind; homeId; workId; route: i32[]; routeIdx; pos; speed; state }
type Demand = { res; com; ind; office }      // -1..+1 each
type CityState = { money; date; population; happiness; approval; rci; budget; milestones }
```

---

## 9. Art & Audio Direction

- **Style:** 2D isometric sprite art in the SimCity 2000 / Transport Tycoon lineage — clean saturated palette, baked soft shadows, strong silhouettes. Readable at a glance at the default zoom; the city must look like a city in a screenshot.
- **Asset strategy:** Modular sprite kit (base/mid/roof/prop tiles composited into atlas frames) + a small set of hand-authored landmarks. 8–16 frame animations for vehicles, 8 for pedestrians. Target **≤ 2 MB** total asset weight across 4–6 atlases.
- **Palette:** calm greens/blues for terrain and water; warm accents for commercial; cool greys for industry; colour-coded service vehicles.
- **Readability rule:** Any overlay must be legible in a 1000×700 screenshot without zooming.
- **Audio:** gentle ambient loop, distinct cues for crisis vs. info, no voice-over.

---

## 10. Roadmap & Milestones

| Milestone | Contents | Exit criteria |
|---|---|---|
| **M0 — Skeleton** | Vite+TS+PixiJS scaffold, terrain gen, isometric camera, chunked tile layers | Pan/zoom over a random map at 60 FPS on the daily driver and 30 FPS on the minimum device. **Full plan in §15.** |
| **M1 — Build** | Road tool, zoning paint, procedural buildings, bulldoze | Player can build a small grid city that persists on reload. **Full plan in §16.** |
| **M2 — Life** | Agent sim, traffic congestion, pathfinding worker, day/night | Visible commuting traffic + jams at 2k citizens |
| **M3 — Systems** | Economy/budget, power & water, demand, milestones, overlays | Full loop: build → grow → crisis → fix |
| **M4 — Polish** | Save/load + export, notifications, HUD polish, audio, tutorial-lite | Playable 2-hour session without bugs blocking progress |
| **M5 — Perf & Ship** | Profiling passes, culling/atlas/batch tuning, offline SW, deploy to static host | 30 FPS on the minimum device @ 5k citizens; public URL live |

P1 features are picked up only after M3 exits, in this order: garbage/health/fire/police → education/parks → one-way/highway → buses → weather.

**Milestone numbering note:** the *Track A performance spike* (§14) was an unnumbered prerequisite that sat between "decide the renderer" and M0. It was deleted unmeasured on 2026-10-28, so its questions were absorbed into M0 (§15).

---

## 11. Risks & Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Minimum target device is weaker than assumed (§13 Q5) and can't hold 30 FPS | High | 2D isometric chosen for headroom; quality ladder (Low/Med/High) ships in M0; hard caps on visible sprite layers + per-chunk culling; floor device validated **within M0 (§15)** before M1 starts |
| R2 | Agent count explodes with population | High | Hard cap active agents at 10k; statistical flow model for the remainder; despawn off-screen agents |
| R3 | Pathfinding cost spikes on large maps | High | Hierarchical pathfinding + per-frame budget (N paths/frame) + path caching per O-D pair |
| R4 | Scope creep past Cities: Skylines parity | High | Non-goals are contractual; P1 features gate on M3 exit |
| R5 | Save corruption across versions | Medium | Schema version + migrations + auto-save rotation + export backup |
| R6 | Safari/iOS WebGL2 quirks | Medium | Feature-detect at boot with a clear unsupported-browser screen (M0 T5.4); Safari tested from M1 |
| R7 | Browser tab throttling (background) | Low | Accept it — no offline simulation to exploit |
| R8 | **The renderer's core chunk strategy is now undecided** — the spike that was meant to decide it was deleted unmeasured | High | M0 ships *both* strategies (RenderTexture-cached vs live sprites) behind a toggle and picks from its own measurements (§15 T3.2/T3.6, decided in §15.4) |

---

## 12. Success Metrics

- **Retention proxy:** ≥ 40 % of sessions run longer than 20 minutes; ≥ 25 % of players return within 7 days (via local analytics-free counters or opt-in ping).
- **Progression:** ≥ 60 % of first-time players reach the first population milestone.
- **Performance:** 30 FPS floor on the minimum target device and p95 frame time < 20 ms on mid-tier, both at 5k citizens.
- **Stability:** < 1 crash / 100 sessions; no save-loss reports.

---

## 13. Decisions (all resolved 2026-10-28)

| # | Question | Decision | What it changed |
|---|---|---|---|
| Q1 | 3D (Three.js) as primary, or 2D isometric first? | **2D isometric first** | Renderer is PixiJS (§4, §7); art direction (§9); R1 rewritten (§11) |
| Q2 | Launch map size | **Standard 512 only** | Small/Large moved to P2 (§2.2, §6.1); no map-size milestone unlock at launch |
| Q3 | Guided first-city scenario or pure sandbox? | **Pure sandbox** | No scenario script; the notification system carries onboarding (§6.11) |
| Q4 | Public "share your city code" in v1? | **No** | Removed from §7; save portability is local file export only (§6.12) |
| Q5 | Minimum target device | **Old 4 GB budget laptop** — dual-core x86, integrated GPU, 4 GB RAM | Sets the 30 FPS floor in §7 and §12; drives the quality ladder |
| Q6 | Keep the throwaway `spike/` app as a reference, or consolidate to one app? | **Delete it, consolidate to one app** | `spike/` removed; app hoisted to repo root. Its measurements were never taken, so §14 is a record only and M0 inherits no renderer verdict (§15.1, R8) |

**Still open (needed before M2):** nothing blocking. The concrete hardware model used for testing is recorded in §15.5.

---

## 14. Track A — 2D Isometric Perf Spike (CLOSED — code deleted, never measured)

> **Status banner.** This section is a **record, not a plan.** The `spike/` app was deleted on 2026-10-28 (decision Q6) before T0.5/T6.2/T6.3 were run, so **no measurement in this section was ever taken** — §14.6 and §14.7 are empty templates. File paths below (`spike/src/*.ts`) point at **deleted** files and are kept only to record what was built and why. Its hotkey/HUD surface went with the code.
>
> Everything this section was meant to answer is now M0's job (§15), except the parts that need buildings and agents — those re-open in M2/M5 with §14.4's scenarios.

**Renderer decision:** already made — **2D isometric on PixiJS** (§13 Q1). This spike did not compare 3D vs 2D.
**Goal:** Prove the 2D isometric renderer + worker-driven sim hold the §7 budgets on the *floor* device, and produce the default quality-ladder setting before M1 starts.
**Nature:** Throwaway code. No gameplay, no systems, no polish.
**Exit artifact:** Filled results table (§14.6) + a verdict (§14.7) naming the default preset and whether the floor device is supported. **Never produced.**

### 14.1 Ground Rules

1. Nothing here is production code. If it can't be measured, don't build it.
2. Thresholds are written down in §14.5 **before** coding. They are not edited after seeing results.
3. Only results from the devices/configs in §14.2 count. Daily-driver-only numbers are not results.
4. Three fixed scenarios (§14.4), fixed seeds, scripted camera paths. Median of 3 runs.
5. Where a §7 budget breaks, report it and fix the budget in this PRD — don't quietly tune the art.

### 14.2 Preconditions

- [ ] **T0.1** Floor device is decided (§13 Q5): **old 4 GB budget laptop** — dual-core x86, integrated GPU, 4 GB RAM, Chrome or Firefox, WebGL2. Write the exact model you test on into §14.6 so the number is reproducible. If no such machine is available, emulate with Chrome CPU throttling 4× and 6× at 2× devicePixelRatio and label every result "emulated".
- [ ] **T0.2** List 3 test devices: floor / mid / daily driver.
- [x] **T0.3** Create a throwaway repo or `spike/` folder — do not scaffold the real project. → `spike/` (Vite + TypeScript + PixiJS, own package.json). **Deleted 2026-10-28.**
- [x] **T0.4** Measurement kit: custom rAF frame-time logger → CSV, PixiJS renderer stats (`drawCalls`, `textureMemory`), Chrome DevTools Performance profiler, `performance.memory` sampling. → built into `src/metrics.ts` (p50/p95/p99, CSV export) + `src/hud.ts`; DevTools profiler was still manual.
- [ ] **T0.5** Baseline: empty Pixi app + one 512×512 terrain tile layer, static camera. Record frame time, draw calls, texture memory as the zero line.
- [x] **T0.6** Serve the floor-device resolution (1× devicePixelRatio, no antialiasing) by default — `RESOLUTION = 1` in `src/main.ts`.

### 14.3 Task List

**Scaffold status at deletion:** `spike/` implemented T1.1–T1.4 (terrain, chunk culling, 4 zoom steps, live-vs-RenderTexture A/B behind `B`), T2.1–T2.4 (single packed atlas, 5,000-building stress toggle behind `V`, dirty-vs-naive agent sync behind `K`, chunk-vs-sprite culling behind `N`), T3.1–T3.5 (10,000-agent SoA worker + 8 Hz transferable snapshots + LOD dots), T4.1–T4.3 (flat A* + hierarchical corridor probe, `T`/`U`/`Y`), T5.1–T5.3 (Low/Med/High ladder behind `M`, Canvas2D fallback behind `O`), and T6.1 (press `R` → 60 s auto-pan recording → CSV downloads by itself). **No numbers were ever recorded.**

#### T1 — Isometric tile streaming & culling
- [x] **T1.1** Generate a 512×512 heightmap (fBm value noise, fixed seed); render terrain as 2:1 iso diamond sprites on an 8 m tile grid.
- [x] **T1.2** Chunk 32×32 tiles; cull chunks against the camera rect so only visible chunks exist in the scene graph.
- [x] **T1.3** Implement 4 discrete zoom steps; log visible sprite count and frame time at each.
- [x] **T1.4** A/B test static-chunk caching: pre-render each chunk's terrain layer into a `RenderTexture` vs. live sprites. This decides the core renderer architecture for M0. → `B` key toggled `live`/`rt`; RT memory reported in the HUD. **Never measured.**
- **Verify:** Scripted 60 s pan across the full map; p95 frame time inside budget; visible-sprite count logged per zoom; no GC hitch > 50 ms.

#### T2 — Sprite batch stress
- [x] **T2.1** Pack terrain + road + building sprites into 1–2 atlases ≤ 2048²; measure texture memory. → one 1024×544 atlas, 272 frames incl. the 8-frame agent band.
- [x] **T2.2** Render 5,000 building sprites with full terrain visible; count draw calls / batch groups. → `V` key spawned 5,000 depth-sorted building sprites.
- [x] **T2.3** Compare per-frame transform updates vs. dirty-only updates — decides whether the renderer mirrors world state or reads the typed arrays directly. → `SyncMode`, `K` toggled `dirty`/`naive`. **Numbers not recorded.**
- [x] **T2.4** Test culling granularity: per-sprite vs. per-chunk. → `CullMode`/`cullSprites`, `N` toggled; sprite mode over-subscribed residency by 1.5 chunks so the per-sprite pass had work to reject. **Numbers not recorded.**
- **Verify:** Draw calls ≤ 150; sprite update cost ≤ 4 ms/frame; texture + city memory inside the 1 GB budget.

#### T3 — Worker agent simulation
- [x] **T3.1** 10,000 dummy agents in a Web Worker using SoA typed arrays. → posX/posZ/aimX/aimZ `Float32Array`s, no per-agent objects; `G` started/stopped 10,000 agents.
- [x] **T3.2** 8 Hz tick; agents walk precomputed routes over a fake grid graph (no real roads yet). → `setInterval(step, 1000/8)`, axis-first walk toward a random aim, retarget on arrival.
- [x] **T3.3** Snapshot to main thread; render as interpolated sprites. Measure `postMessage` transfer cost. → one interleaved `Float32Array` per tick, transferred (zero-copy); interpolated between `prev`/`curr`; HUD/CSV reported `recv ms` and snapshot `gap ms`.
- [x] **T3.4** Test `SharedArrayBuffer` if headers are available — **note:** GitHub Pages cannot send COOP/COEP, so confirm the transferable-`ArrayBuffer` path is fast enough on its own; treat SAB as dev-only. → SAB explicitly ruled out and documented; the transferable path is the shipping one.
- [x] **T3.5** Far-zoom degradation: 8-frame animated sprites → 1-frame dots; measure the saving. → 8-frame agent band, `resolveLod` switched to dots at `dotZoom`; `L` forced `auto`/`animated`/`dot`/`off`.
- **Verify:** Sim tick ≤ 60 ms for 10,000 agents; main-thread frame time unaffected by agent count.

#### T4 — Pathfinding cost probe
- [x] **T4.1** 512×512-node graph; A* for 500 random O-D pairs per tick. → `pathfind.ts` (4-connected, Manhattan, `Infinity` = water) + `U` queued 500 hotspot pairs.
- [x] **T4.2** Per-frame path budget (N paths/frame) + O-D path cache; measure hit rate. → `PathProbe` spent `budgetMs` (3 ms) per frame, Map cache keyed by hashed O-D pair with FIFO eviction; `X` cleared it.
- [x] **T4.3** Prototype one hierarchical layer (cluster contraction); measure speedup factor. → `HierarchicalPathfinder` (32-tile clusters → coarse A* → 1-ring corridor → fine A*); `T` toggled, `Y` benchmarked flat vs hier on identical pairs.
- **Verify:** Numbers for A* ms/path, paths/frame inside budget, cache hit %, hierarchical speedup. **Never produced.**

#### T5 — Quality ladder + Canvas2D fallback viability
- [x] **T5.1** Implement Low / Med / High: render scale (0.6/0.85/1.0), visible layer count, animation rate, overlay update rate, antialias, effects off. → `quality.ts` (renderScale, agentRenderCap, agentDotZoom, overlayEveryFrames).
- [x] **T5.2** Live toggle for testing. → `M` cycled Low → Med → High.
- [x] **T5.3** Measure the Canvas2D fallback path on the same scene. Decide between a real fallback and a "browser unsupported" screen. → `canvas2d.ts`, `O` toggled (extracted the atlas, diagonal painter-order blit, no agents). **Decision never taken.**
- **Verify:** Low holds the floor device at ≥ 30 FPS in S3; Canvas2D either holds ~30 FPS at S2 or is dropped.

#### T6 — Harness & reporting
- [x] **T6.1** One-button run: load seed → scripted camera path → log frame times → CSV. → `P` auto-pan sweep + `R` recorded 60 s and downloaded the CSV automatically.
- [ ] **T6.2** Fill §14.6 with p50/p95 frame time, draw calls, visible sprites, sim tick ms, memory. **Not done — code deleted.**
- [ ] **T6.3** Write the §14.7 verdict. **Not done — code deleted.**

### 14.4 Benchmark Scenarios (fixed)

| # | Scenario | Setup |
|---|----------|-------|
| S1 | **Empty sweep** | 512×512 terrain only, 60 s camera path, all zoom steps exercised |
| S2 | **Dense city** | 5,000 building sprites + overlays on, static camera then 30 s pan |
| S3 | **Rush hour** | S2 + 10,000 agents simulated and rendered, 120 s run, worst-case zoom-out |
| S3L | **Rush hour, Low** | S3 on the Low preset — the shipping config if the floor device needs it |

Run each 3× per device/config; report the median.

**Still live:** S1 is effectively M0's A2 (§15.3). S2/S3/S3L cannot run until M1 (buildings) and M2 (agents) exist — re-open them then.

### 14.5 Decision Matrix (write once, do not edit later)

**Proceed to M1 with 2D isometric as specced if ALL of:**
- S3 p95 ≤ 33 ms on the mid device at Med, and ≤ 20 ms on the daily driver at High
- S3L p95 ≤ 33 ms on the floor device
- Sim tick for 10,000 agents ≤ 60 ms
- Draw calls ≤ 150, memory ≤ 1 GB in S3

**If Med fails but Low holds the floor device:** ship **Low as the default**, Med optional; record the cap in §7.

**If Low fails on the floor device, apply in order until it passes:**
1. Pre-render static chunk layers to `RenderTexture` (T1.4), keep only buildings/agents live
2. Drop to 1-frame agent dots above the first zoom-out step
3. Reduce the agent render cap for the floor tier (sim keeps running, rendering is LOD'd)
4. Halve overlay update rate (2 Hz instead of per-frame)

**If it still fails after all four:** the floor device is off the support list. This is the only outcome that changes the stated minimum — it must be reported explicitly, never absorbed silently.

**Canvas2D fallback:** keep only if it holds ≥ 30 FPS in S2. Otherwise ship a clear "your browser is unsupported" screen.

> **Live use:** this ladder is the mitigation order §15.4 falls back on.

### 14.6 Results Table (never filled)

| Device | Scenario | Preset | p50 frame ms | p95 frame ms | Draw calls | Visible sprites | Sim tick ms | Peak mem MB |
|---|---|---|---|---|---|---|---|---|
| floor | S1 | Med | — | — | — | — | — | — |
| floor | S2 | Med | — | — | — | — | — | — |
| floor | S3L | Low | — | — | — | — | — | — |
| mid | S3 | Med | — | — | — | — | — | — |
| driver | S3 | High | — | — | — | — | — | — |

Supporting numbers: **none taken** (T1.4 static-chunk A/B · T2.3 update cost · T3.3/T3.4 transfer · T4 pathfinding · T5.3 Canvas2D — all blank).

### 14.7 Verdict (never written)

> Renderer: **2D isometric (PixiJS) — unvalidated.** No floor-device evidence exists.
> Default preset: **undecided.** Floor device supported: **undecided.**
> Chunk strategy: **undecided** — now decided in M0 §15.4. Canvas2D fallback: **decided — declined** (2026-10-28): no blitter is built; boot shows an unsupported-browser screen instead (§16 T8, §4).

### 14.8 Exit Criteria (unmet, superseded)

- [ ] §14.6 filled for all device × scenario combinations — **superseded by §15.5**
- [ ] §14.7 verdict written — **superseded by §15.4**
- [ ] §7 budgets corrected to measured numbers; §4 minimum-device row filled with the real model — **carried into M0 §15.6**
- [x] Spike code quarantined or deleted — **deleted 2026-10-28 (Q6)**

---

## 15. Phase M0 — Skeleton (ACTIVE PHASE PLAN)

**Goal:** Stand up the real (non-throwaway) project skeleton — deterministic world core, chunked 2D-isometric renderer, camera, quality ladder and a slim perf harness — and hold the §7 budgets on the minimum target device.
**Nature:** Production code at the repository root. This is the codebase M1 builds on. **No gameplay.**
**Exit artifact:** A static build that boots to a playable, pannable map + the filled §15.5 evidence table.

### 15.0 Ground Rules

1. Production code, not a spike: no dead ends, no "we'll fix it later" seams in the world/renderer boundary.
2. This PRD is the spec. Where M0 must deviate, the PRD is edited in the same change — never silently.
3. Every budget claim needs a number from a real device, or is explicitly labelled "emulated" (§15.2 T0.5-style discipline from §14.1).
4. M0 adds zero gameplay. If it is not terrain, camera, renderer, shell or harness, it waits for its milestone.
5. **M0 now owns the performance verdict.** The Track A spike (§14) was deleted before it was ever measured, so **no renderer decision is inherited**. Anything that needs a number is built as an A/B toggle and decided in §15.4 from M0's own measurements.

### 15.1 Preconditions

- [ ] **B1** Floor device decided (§13 Q5) — the exact model recorded in §15.5, or every result labelled "emulated (Chrome CPU throttle 4×/6×)".
- [ ] **B2** A second device available (mid-tier or daily driver). A single-device result is not a result (§14.1 rule 3).

> **No hard blocker remains.** Because §14 produced no verdict, M0 carries the floor-device risk itself: T3.2/T3.4/T3.6 must ship **both** chunk strategies behind a toggle, and §15.4 picks the survivor. This is the cost of deleting the spike unmeasured (§13 Q6, §11 R8).

### 15.2 Task List

#### T1 — Project skeleton
- [x] **T1.1** Production project (Vite + TypeScript + PixiJS) at the **repository root** — hoisted out of `cityscope/` on 2026-10-28 so the repo holds exactly one app.
- [x] **T1.2** `tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`, `target ES2022`, `moduleResolution bundler`, plus `noImplicitOverride` and `noFallthroughCasesInSwitch`.
- [x] **T1.3** `vite.config.ts`: `base: './'` for static hosting, `build.target: 'es2022'`, and the `@xmldom/xmldom` → ESM stub alias (the one thing salvaged from the spike; without it the build breaks). Dev port **5175**, preview **4175**.
- [x] **T1.4** Module layout: `src/core` (noise, rng, time), `src/world`, `src/render`, `src/ui`, `src/debug`. Enforce the direction `ui → render → world → core` with no cycles. Directories created; only `render/` has an inhabitant so far (`render/app.ts`). The direction is trivially satisfied until T2/T3 land.
- [x] **T1.5** Scripts: `dev`, `build`, `preview`, `typecheck`. `build` runs `typecheck` first and must exit 0.
- [x] **T1.6** Static-host smoke: `npm run build && npm run preview` serves a page that boots. GitHub Pages deploy is **M5**, but the build must already be Pages-compatible. → Build emits **relative** `./assets/...` URLs, and no `xmldom` reference survives into `dist/`.

**T1 results (2026-10-28):** `npm install` 0 vulnerabilities · `npm run build` exits 0 (`✓ built in 434ms`) · `npm run preview` and `npm run dev` both serve 200 on `/`, `/src/main.ts`, `/src/render/app.ts`, `/src/xmldom-stub.ts` · **initial JS ≈ 106 kB gz, whole `dist/` 157 kB gz** — far inside the §4 2 MB budget.

> **Scope note:** T1.6's wording ("boots and **pans**", "renders a **map**") runs ahead of T1 — panning is T4 and the map is T2/T3. What T1.6 asserts here is the *static-host half*: a Pages-compatible build, served by `preview`, that visibly draws. A blank canvas would pass a build check while proving nothing about WebGL, so boot draws the 2:1 isometric lattice with `Graphics` (the same plane the real renderer uses, §4) plus a label. That placeholder is deleted by T3.2, and the pan/map assertion is re-run in T4 and again in T7.1.

#### T2 — Deterministic world core
- [x] **T2.1** Seeded PRNG (`mulberry32`) + value-noise fBm, **written fresh** — the spike's `noise.ts` was deleted and is not recoverable. → `src/core/rng.ts`, `src/core/noise.ts`. Every operation is one the spec pins exactly (`Math.imul`, xor-shift, `Math.floor`, IEEE mul/div) so the field is engine-independent; the usual `Math.sin(dot) * 43758.5453` lattice hash was deliberately rejected because its precision is implementation-defined.
- [x] **T2.2** World data in SoA typed arrays per §8: `height: Float32Array`, `terrain: Uint8Array` (terrain class, **not** an atlas frame id — the atlas belongs to the renderer). 512×512 tiles, 32×32 chunks. → `src/world/world.ts`. No per-tile object exists anywhere.
- [x] **T2.3** Classification thresholds (water / sand / grass / forest / rock / snow) live in exactly one place, derived from a single config object. → `WORLD_CONFIG.bands` in `src/world/config.ts`; `classify()` takes the bands as a *parameter* so they cannot be duplicated (five lower bounds cover all six classes).
- [x] **T2.4** **Save-compatibility decision:** the world is `seed + sparse edit diffs`, because terrain raise/lower is P0 (§6.1). Implement the diff container and the "apply diffs over generated map" path **now**, even with zero edits — retro-fitting this after M1 is expensive. → `World.edits: Map<index, TerrainEdit>`, `setTile()` is the *only* post-generation mutator so nothing can escape the save, and `generate()` ends by replaying the diffs, which makes regeneration the load path.
- [x] **T2.5** World telemetry: `seed`, `tiles`, `buildMs`, `waterRatio`, and a **content hash** so a save can detect a generation mismatch. → FNV-1a over the bytes of both arrays; surfaced at boot and on `window.cityscope`.
- **Verify:** the same seed produces byte-identical `height`/`terrain` arrays across two browsers and across reloads (hash compare).

**T2 results (2026-10-28):** `npm run build` exits 0, typecheck clean on the first attempt. Ran headless against the real sources (esbuild → Node, throwaway script, not committed):

| Check | Result |
|---|---|
| Same seed twice | `58d96159` = `58d96159` → identical |
| Different seed | `fdb65ae1` ≠ `58d96159` → differs |
| Map build | **38 ms** for 262,144 tiles (budget: ≤ 3,000 ms, §6.1) |
| Terrain mix | Water 29.0% · Sand 8.1% · Grass 32.8% · Forest 19.4% · Rock 9.3% · Snow 1.4% — all six classes reachable |
| Edit round-trip | save = seed + 1 diff → reloaded hash equals the edited world; a fresh world still matches pristine |

> The two-browser half of the T2 verify is still **outstanding** — it needs the actual browsers, so it lands with T7.1. The Node run proves determinism *within* one engine; it cannot prove it *across* engines. The cross-engine argument rests on using only exactly-specified operations, which is why `Math.sin`-based hashing was rejected above.
>
> A first cut used a Euclidean radial falloff and produced a **64% ocean** map: the falloff was clamped inside the unit disk, so a fifth of the map sat at minimum elevation and the whole interior was dragged toward sea level. Replaced with a Chebyshev falloff that only bites outside `edgeInner` (0.68), giving the 29% above. Rejected alternatives for the record: raising the water threshold instead (moves the coastline arbitrarily) and dropping the falloff entirely (map becomes an arbitrary crop of the noise field with no boundary).

#### T3 — Renderer core
- [x] **T3.1** Atlas pipeline: terrain frames only. One texture ≤ 2048², generated at boot or loaded from an asset — decide and record why. Building/agent bands are explicitly **not** built here. → **Generated at boot with Canvas2D**, in `src/render/atlas.ts`. Six flat diamond frames (Water…Snow) as a gradient-filled 384×32 `CanvasSource` + six `Texture` views over it. A PNG would be a network round-trip plus a decode for something the GPU can be handed in under a millisecond, and it would put the asset weight above zero. When M1 brings real modular art the atlas flips to *loaded* and only this file changes.
- [x] **T3.2** Chunk streamer: derive the needed set → build missing views → recycle departed ones. **Ship both strategies behind one toggle** — RenderTexture-cached chunks (T3.4) and live sprites — and let §15.4 pick. Culling granularity: per-chunk vs per-sprite, also measured here. → `src/render/chunkLayer.ts`. Resident set chosen by AABB-testing every chunk's display bounds against the camera rect expanded by `CHUNK_MARGIN = 1`; departed views are destroyed and their RenderTextures freed. Both strategies and both culling granularities are live behind toggles (`C`, `V`).
- [x] **T3.3** Layer skeleton: terrain layer now, plus reserved (empty) road / building / agent / overlay container slots so M1 and M2 slot in without re-architecting. → `RenderLayers` in `src/render/renderer.ts`, five labelled containers added to the camera root in §7 order. Only `terrain` has content.
- [x] **T3.4** Quality ladder (Low / Med / High) wired from boot; live-cycle for testing. Preset values (§14.5 ladder): render scale 0.6 / 0.85 / 1.0. → `src/render/quality.ts` + `M` to cycle. The ladder only moves render scale in M0; the remaining §14.5 mitigation steps are either the T3.2 strategy toggle or need systems M0 does not have.
- [x] **T3.5** Resolution policy: render at 1× devicePixelRatio by default; the ladder may drop below 1 for the floor tier. → implemented as `dpr(clamped to 2) × preset.renderScale`, applied through `renderer.resolution` with `autoDensity` so the browser upscales rather than relaying out. The cap exists because a 3× phone would otherwise allocate nine times the pixels. **Boot preset is Med**, so the effective boot resolution is 0.85×dpr — T7.2 picks the shipping default.
- [x] **T3.6** Rotation: rebuild vs re-project — **both** behind a toggle, decided in §15.4. → rotation is a permutation of the tile grid (`src/render/projection.ts`), so `world.height`/`world.terrain` are never rewritten. `reproject` re-places the existing live sprites in walk order; `rebuild` releases the resident set and lets the next frame recreate it. In `cached` mode a bake is pixels, not geometry, so a rotation re-bakes either way — recorded rather than hidden.
- **Verify:** a 60 s pan over the full map at every zoom step stays inside the frame budget with no hitch > 50 ms. → **passes**, see below.

> T3.2, T3.4 and T3.6 were previously gated on the spike's §14.7 verdict. That gate is gone; they now carry both implementations so §15.4 can decide from evidence.

**T3 results (2026-10-28):** `npm run build` exits 0 · initial JS **297 kB / 89 kB gz** (`dist/` total **168 kB gz** across all chunks) · zero console errors, zero uncaught exceptions. Driven headless over CDP against the served `dist/` (`window.cityscope.view`), 1600×900 logical, Med preset. **This is the dev machine, not the §15.1 floor device — provisional until T7.1.**

60 s pan per zoom step, one traversal of the full diagonal, paced from real elapsed time so the centre — the heaviest view — is genuinely sampled. Run twice; peaks below are **identical in both runs** and the run-to-run p95 spread is ≤ 0.1 ms:

| Zoom step | px/tile | fps | p50 | p95 | p99 | max | frames > 50 ms | peak chunks | peak sprites |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 16 | 59.7 | 16.7 | 16.7 | 16.8 | 33.5 | **0** | 85 | 87,040 |
| 2 | 32 | 60.0 | 16.7 | 16.7 | 16.8 | 16.8 | **0** | 45 | 46,080 |
| 3 | 64 | 60.0 | 16.7 | 16.7 | 16.8 | 16.8 | **0** | 28 | 28,672 |
| 4 | 128 | 60.0 | 16.7 | 16.7 | 16.8 | 33.4 | **0** | 25 | 25,600 |

Peak sprites are exactly `peak chunks × 1024` because the sweep ran with the boot default of per-**chunk** culling, which leaves the whole resident set visible — including the `CHUNK_MARGIN` overshoot the toggle exists to expose. The streamer's own share of a frame (`view.update()`, timed inside the ticker) averaged **0.92–1.56 ms**, worst single update **16.1 ms**; the worst single frame created **7 chunks at once** (7,168 sprites). Across both runs — 8 legs, 480 s of continuous panning — the number of frames above 50 ms was **zero**.

> **On the p95 figure.** 16.7–16.8 ms *is* the 60 Hz refresh period (16.667 ms) sampled to 0.1 ms: a frame cannot complete faster than the vsync it is measured against, so §15.4's literal "p95 ≤ 16 ms" sits below one refresh period and is unreachable on a 60 Hz display. The operative reading is "p95 within one refresh period and no stall > 50 ms", which holds at every zoom step. The criterion itself is left untouched here — §15.4 is write-once and a threshold must not be adjusted to fit a result — but the reading has to be recorded explicitly rather than discovered at T7.2.

A/B numbers for §15.5, all measured at **zoom step 1** (the widest view: 85 chunks / 87,040 sprites resident). This is deliberate — at a tighter zoom the resident set is ~6 chunks, where `live` and `cached` are 6,144 drawables against 6 and the comparison says nothing. 10 s pan, same camera path for both sides:

| A/B | Left | Right | Verdict signal |
|---|---|---|---|
| Chunk strategy (T3.2) | `live` — **87,040** drawables, **1.47 ms** streamer/frame | `cached` — **85** drawables, **0.68 ms** | both 60 fps here; cached is 2.2× cheaper on the CPU side and cuts the drawable count ~1,024× — the difference that matters on a weak GPU |
| Culling granularity (T3.2) | `chunk` — 87,040 drawn, **1.47 ms** | `sprite` — 5,326 of 21,504 drawn at the leg's end, **2.78 ms** | per-sprite culling *costs* 1.9× more CPU than it saves; it only pays if the GPU, not the CPU, is the bottleneck |
| Rotation (T3.6) | `rebuild` — **14.5 ms**/quarter turn (max 24.8) | `re-project` — **2.9 ms**/quarter turn (max 8.3) | re-project is ~5× cheaper and stays inside one frame; rebuild spends one-and-a-half |

Rotation correctness: the terrain layer's sprite signature is distinct for all three quarter turns and a 0° → 360° round trip returns byte-identical (`5aea15dc` = `5aea15dc`), so the permutation is genuinely applied and genuinely invertible.

The `cached` quality trade, for §15.4: a chunk is baked at `renderer resolution × camera pixel scale`, capped at 2048². At zoom step 1 that product is 0.2125, clamped up to the 0.25 floor — and a chunk occupies 512 screen px there, so the bake is still 1:1 and costs nothing visible. At zoom step 4 the cap bites instead (1.0 against the 1.7 the view wants), i.e. the texture is undersampled ~1.7× and a zoomed-in cached chunk is softer than a live one. That is the price of the ~1,024× drawable reduction, and it is a §15.4 input rather than a defect.

> **Two bugs the verification caught, both fixed.** (1) `applyCamera()` never told the streamer the camera's rotation — `Q`/`E` rotated the projection while the tile contents stayed put, so terrain and pan direction disagreed after a turn. The rotation is now pushed from `applyCamera()`, which is also the single place the T3.6 rebuild/re-project choice is applied. (2) The `cached` strategy tracked no sprite, so `visibleSprites` reported `0` and per-sprite culling silently did nothing there; a chunk now holds an explicit `display` sprite, which is what `measure()` counts.
>
> **One measurement caveat for whoever repeats this.** The first two headless runs each showed a small number of > 50 ms frames (one 516 ms outlier, then 2× 66.7 ms). Neither reproduced: the streamer's share of those frames was ≤ 19.8 ms, and both runs also stalled mid-sweep because Chrome throttles rAF for an occluded headless page. With `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion` the sweep completed with **0** hitches at every zoom step. Any hitch measurement taken without those flags is measuring the harness, not the renderer.
>
> **Two ways the harness itself lied, both found and fixed; both would have produced plausible-looking wrong numbers.** (1) The pan moved a fixed 2 tiles per frame, so each leg raced to a corner in ~4 s and then idled there — sampling 21 chunks where the widest view actually holds 85, i.e. never measuring the heaviest view at all. The pan is now paced from real elapsed time across one traversal of the diagonal, and each leg reports its peak resident set so the sampling can be checked instead of assumed. (2) A fixed CDP port is a trap: `chrome.kill()` reaps the launcher but not Chrome's forked children, so a *previous* run's browser still held the port and the harness attached to that page — which still carried the toggles the previous sweep had left set (`sprite` / `reproject`), making a fresh build look like it booted with non-default settings. The port is now randomised per run. Both failures looked exactly like a real result.
>
> The `cached` strategy's re-bake is spread (`BAKES_PER_FRAME = 2`) because re-baking every resident chunk in one frame would be a stall by construction. The artefact is a moment of softness at a zoom edge while a stale bake is still on screen — a deliberate trade, recorded here rather than hidden.

#### T4 — Camera & input
- [x] **T4.1** Pan: middle-drag, left-drag, WASD/arrows, edge scroll (§6.2).
- [x] **T4.2** Zoom: discrete tile-scale steps via wheel and `1`–`4`.
- [x] **T4.3** Rotation: `Q`/`E` in 90° steps.
- [x] **T4.4** Clamp to map bounds; anchor snaps to tile centres; explicit recenter.
- [x] **T4.5** Measure input → camera-response latency and confirm < 16 ms (§6.2).
- **Verify:** every camera action is reachable without a mouse. **This is where T1.6's "pans" clause is finally satisfied.** → **passes**

**T4 results (2026-10-28):** `npm run build` exits 0 · initial JS **301 kB / 90.3 kB gz** · zero console errors, zero uncaught exceptions. Driven headless over CDP against the served `dist/`, 1600×900 logical, Med preset, one camera action per check. **22/22 checks.** Dev machine, not the §15.1 floor device — provisional until T7.1.

- **Keyboard reachability (T4.1–T4.4).** Every action was exercised with *only* key events — W/A/S/D, ArrowLeft, `1`–`4`, `Q`/`E`, `0` — and each moved the camera in the asserted direction. Drag, wheel and edge scroll are conveniences on top, not the only way in, so §6.2's acceptance sentence and T1.6's "pans" clause are both met.
- **Snap on settle (T4.4).** The anchor is free while the camera moves (sampled mid-hold: `251.31`) and integral at rest (`251`). §6.2 says the anchor "snaps to tile centres"; snapping *continuously* would make a drag step tile by tile — up to 64 px at the closest zoom — so it is applied on the stop transition only. Confirmed for the pan keys, for a drag release and after an edge scroll.
- **Clamp + recentre (T4.4).** Four successive full-window middle-drags from `(3,3)` land on `(0,0)`: the bound is reached and held, not merely approached. `0` returns the anchor to the map centre exactly.

**Input → camera-response latency (T4.5).** Two numbers, because only one of them is the app's.

| | p50 | p95 | max |
|---|---|---|---|
| Delivery → applied frame, **`cached` (shipped)** | **2.8 ms** | **15.7 ms** | **17.2 ms** |
| Delivery → applied frame, `live` | 11.4 ms | 19.8 ms | 26 ms |
| Frame period, `cached` / `live` | 16.7 / 16.7 ms | 17.8 / 30.5 ms | 22 / 34 ms |

50 paired events (30 wheel notches, 20 key presses) over ~240 frames, with the **wheel alternating zoom steps** so each event really changes the camera and the frame carries the streaming work. Both paths are inside §6.2's 16 ms at p50, and the shipped configuration is inside it at p95; **no frame exceeded 50 ms in either configuration.**

> **The number that is not ours.** The product also scores `frame − event.timeStamp`. In this environment that reads p50 ≈ 40 ms, and it is *not* our response time: measured on the page's own clock, an injected **wheel** event reaches the handler 43–53 ms after dispatch, while an injected **key** reaches it in 0.8–8.6 ms through the same channel. That is Chrome's compositor wheel path in a software-rendered headless browser — upstream of any code in this repo. The table above measures the boundary the app controls, from delivery into our own handler to the frame in which the camera moves. Do not quote the `event.timeStamp` figure as app latency.

> **A defect this task found, and its fix.** The first run of the latency check failed at p95 39.8 ms with frames up to 84.4 ms. Attribution (wrapping `view.update`, correlating frames with zoom changes) put **49.6 ms of an 84.4 ms frame inside our own update**, while idling at the *same* zoom cost 3–5 ms. Cause: `reconcile()` built every newly-wanted chunk in one frame, and a zoom-out re-derives the whole resident set at once — ~70 chunks × 1024 sprites ≈ 50 ms of synchronous sprite construction, with panning only ever needing a couple. Fix: `VIEWS_PER_FRAME = 4` in `chunkLayer.ts`, the same shape as the existing `BAKES_PER_FRAME`. Worst frame went **84.4 → 22 ms** and the p95 failure cleared. This is the class of bug M0 exists to catch: invisible in the T3 sweep, which held zoom constant.

> **What decided §15.4.** Chasing that residual tail, the zoom-churn run was repeated under both chunk strategies. It is not the chunk-build budget that separates them — halving it changed nothing — it is what the frame *draws*: with `live` the frame rasterises 73,728 sprites, with `cached` it draws 72. §15.4's chunk-strategy pick is therefore recorded as **`cached`** and the default flipped accordingly. §15.4's culling and rotation picks are left open — see the block-quote there.

> **One conflict to carry forward.** `1`–`4` are T4.2's zoom steps, but §6.2 reserves `1`–`9` for the M1 tool bar. The zoom keys must move when that lands; noted here so it is not discovered as a bug then.

#### T5 — App shell & loop
> **Parked 2026-10-28 — M1 started first.** §10's exit test for M0 ("pan/zoom a random map at 60 FPS") is already met by T1–T4, so the remaining M0 tasks were not blocking a playable build. On the user's call the phase was stopped here and M1 began (§16). Two of these four items moved rather than staying parked, because M1 cannot do without them; the other two wait for M2, which is the first thing that needs a fixed step or a worker. Nothing here is cancelled — §15.6's exit criteria are restated against §16 for a later pass.

- [ ] **T5.1** DOM HUD frame with the §6.11 placeholders — **moved to M1** (§16 T7), which needs a HUD whose population figure is real.
- [ ] **T5.2** Fixed-step accumulator at **8 Hz** + rAF render with interpolation (§7) — **parked to M2**. M1 is edit-driven, not simulated: a building appears the instant a valid tile is painted and nothing advances on a clock, so an 8 Hz step would tick over an empty world. M2 is where it earns its keep.
- [ ] **T5.3** Worker round-trip health check over `postMessage` — **parked to M2**, the first milestone with a simulation to put in a worker. No SharedArrayBuffer then either (GitHub Pages cannot send COOP/COEP — §14.3 T3.4).
- [x] **T5.4** Boot feature-detect + clear unsupported-browser screen (§11 R6). **This also decided the Canvas2D-fallback question §14.7 left open: no blitter — the unsupported screen is the answer** (user, 2026-10-28). Delivered as part of M1's boot (§16 T8) because the interaction layer M1 adds deserves a real failure path rather than a black canvas.
- **Verify:** tick counter holds 8 Hz with no drift over a 10-minute run. → **carried into M2** with T5.2; there is no tick counter to measure until then.

#### T6 — Debug & perf harness (slim)
> **Parked 2026-10-28.** M1 adds a debug readout of its own (§16 T7) but not the measurable harness this task describes; that is worth building once M2 produces numbers worth logging in a CSV.

- [ ] **T6.1** Frame-time p50/p95/p99 + stall counter, behind a debug key.
- [ ] **T6.2** Counts: visible sprites, chunks, batch groups, JS heap.
- [ ] **T6.3** One-button CSV export covering an acceptance run.
- [ ] **T6.4** Live quality-preset cycling.
- **Verify:** harness costs < 1 ms/frame while visible and ~0 when hidden.

#### T7 — Validation & handoff
> **Parked 2026-10-28.** T7 exists to close M0's numbers, and M0 stopped before it produced the workload T7 was meant to measure (see T5/T6). It runs after M2, when the city has systems in it and the floor-device question can be answered against something representative. §15.4's two open picks (rotation strategy, default preset) remain open and remain T7.2's.

- [ ] **T7.1** Run the §15.3 acceptance scenarios on the daily driver **and** the minimum device.
- [ ] **T7.2** Fill §15.5; then pick the chunk strategy, rotation strategy and default preset in §15.4.
- [ ] **T7.3** Correct §7 budgets wherever M0 measures differ; put the real hardware model into §4. Update §11 R1/R8 and §12 to match.
- [ ] **T7.4** Re-open §14.4's S2/S3/S3L as M2/M5 entry scenarios once buildings and agents exist.

---

### 15.3 Acceptance Scenarios (fixed)

| # | Scenario | Setup |
|---|----------|-------|
| A1 | **Idle** | Boot to a generated map, static camera, 30 s. Establishes the zero line. This *is* §14.4's S1 (empty sweep), without the camera path. |
| A2 | **Sweep** | 60 s scripted pan across the full map, exercising every zoom step plus one rotation. |
| A3 | **Cold load** | Hard reload with the cache disabled; measure to first interactive frame. |

Every zoom step must be sampled in A2 — the worst frame is almost always the widest view.

### 15.4 Decision Gate (write once, do not edit later)

**Proceed to M1 if ALL of:**
- A2 p95 ≤ **16 ms** on the daily driver, and ≤ **33 ms** on the minimum target device
- A3 cold load ≤ **10 s** on 20 Mbps; initial JS ≤ **2 MB** gzipped
- Map generation ≤ **3 s** on the minimum device (§6.1)
- No stall > 50 ms during A2
- Same seed → identical world hash on two different browsers
- Chunk strategy, rotation strategy and default preset **chosen from §15.5 and written down here**

**If the minimum device fails:** apply §14.5's mitigation ladder in order — RenderTexture-cached chunks → lower default preset → reduce render scale below 1.0.

**If it still fails:** the §4 minimum-device row changes. This is the only outcome that alters the stated floor and it must be reported explicitly — never absorbed silently.

> **Partial pick, 2026-10-28.** This clause asks for three decisions from §15.5. One is now taken on measurement; two are deliberately left open.
>
> - **Chunk strategy → `RenderTexture-cached`.** Decided, and the default in `chunkLayer.ts`. Two independent measurements agree: at the widest zoom it costs 1,024× fewer drawables and 2.2× less streamer time (T3), and — decisively — it is the only one of the two that holds §6.2's input budget through a zoom change (T4: app-side p95 15.7 ms vs 19.8 ms, wheel p95 3.1 ms vs 15.6 ms, worst frame 22 ms vs 34 ms). This is §14.5's mitigation 1, reached by measurement rather than by the ladder's ordering.
> - **Rotation strategy — open.** T3 measured `re-project` at ~5× cheaper than `rebuild` for `live` sprites, but under the new `cached` default a rotation re-bakes the resident set either way (a bake is pixels, not geometry — §15.5), so that 5× does not transfer. Do not close this on the `live` number.
> - **Default preset — open.** `Med` is what M0 has been measured at, not a decision against `Low`/`High`; that needs the floor device (§15.1/T7.1).
>
> Both open items are T7.2's, and T7.2's numbers are the ones that close them. Nothing above changes the thresholds themselves.

### 15.5 Evidence Table (fill in)

| Device | Scenario | Preset | p50 ms | p95 ms | p99 ms | Draw calls | Visible sprites | Map build ms | Heap MB | Load s |
|---|---|---|---|---|---|---|---|---|---|---|
| floor | A1 | Med | | | | | | | | |
| floor | A2 | Med | | | | | | | | |
| mid | A2 | Med | | | | | | | | |
| driver | A2 | High | | | | | | | | |

Supporting numbers:
- **Bundle:** initial JS `90.3 kB gz` · all chunks `168 kB gz` · total assets `0 kB` (the terrain atlas is generated at boot, T3.1)
- **Determinism:** world hash `____` on Chrome vs `____` on Firefox → match `yes/no`
- **Loop:** measured tick rate `____ Hz` over 10 min → drift `____ ms`
- **Chunk strategy A/B (T3.2):** `RenderTexture-cached — 85 drawables, 0.68 ms` vs `live sprites — 87,040 drawables, 1.47 ms` — streamer time per frame at the widest zoom (step 1, full-map resident set); both held 60 fps *(T3, dev machine — provisional)*
- **Chunk strategy under zoom churn (T4.5, this is what settled §15.4):** `cached — app p95 15.7 ms, worst frame 22 ms` vs `live — app p95 19.8 ms, worst frame 34 ms` — 50 paired input events with the wheel alternating zoom steps *(T4, dev machine — provisional)*
- **Culling granularity (T3.2):** `per-chunk — 1.47 ms, 87,040 drawn` vs `per-sprite — 2.78 ms, 5,326 of 21,504 drawn` *(T3, dev machine — provisional)*
- **Rotation A/B (T3.6):** `rebuild 14.5 ms` vs `re-project 2.9 ms` — median per quarter turn over 8 turns. **Measured with `live` sprites; it does not transfer to the `cached` default** (see §15.4). *(T3, dev machine — provisional)*
- **Input latency, delivery → applied frame (T4.5):** p50 `2.8` · p95 `15.7` · max `17.2` ms, `cached`; frame period p50 `16.7` · p95 `17.8` · max `22` ms; **0 frames > 50 ms** *(T4, dev machine — provisional)*
- **Chunk build budget (T4.5):** worst frame under zoom churn `84.4 ms` unbudgeted → `22 ms` with `VIEWS_PER_FRAME = 4` *(T4, dev machine — provisional)*
- **Pan sweep (T3 verify, A2 shape):** p50 `16.7` · p95 `16.7–16.8` · max `33.5` · frames > 50 ms `0` — 60 s per zoom step × 4 steps, **repeated twice with identical peak chunk counts** *(T3, dev machine — provisional)*
- **Canvas2D (T5.4):** **declined by decision, not measured** — no blitter was built. Boot feature-detects WebGL2 and falls back to an unsupported-browser screen (§16 T8) *(2026-10-28)*

> The A/B rows are filled from T3's and T4's own measurements (§15.2) because they are the only evidence that exists for them. They are all from the dev machine and none is from the §15.1 floor device, so §15.4's pick still has to be confirmed by T7.1/T7.2. Note also that p95 lands *on* the 60 Hz refresh period, so these rows cannot resolve anything finer than one frame — see the p95 note in §15.2.

### 15.6 Exit Criteria

- [ ] §15.5 filled for A1 and A2 on both devices, A3 once per device
- [ ] §15.4 decision gate passed, or the deviation is documented and this PRD updated
- [ ] Chunk strategy / rotation strategy / default preset recorded in §15.4
- [ ] §7 budgets corrected to measured numbers; §4 minimum-device row names the real hardware
- [ ] A fixed seed yields identical world hashes on two browsers
- [ ] Tick rate holds 8 Hz with no drift over 10 min
- [ ] No spike module imported by production code (vacuously true — `spike/` is deleted)

### 15.7 Carried Over From the Spike

The spike was deleted (Q6), so nothing can be promoted. **`src/xmldom-stub.ts` is the only artifact that survived** — it was already copied into the production project during T1.3.

Everything else is written fresh from §7/§8. In particular, do **not** go looking for `spike/src/noise.ts`, `world.ts`, `scene.ts`, `camera.ts`, `quality.ts`, `agents.ts`, `pathfind.ts` — they are gone. The *designs* they proved are recorded in §14.3 and should inform the rewrite; the code is not available.

### 15.8 Do-Not-Build List (M0 scope guard)

- Roads, zoning, buildings, bulldoze → **M1**
- Any agents, pathfinding, traffic → **M2**
- Economy, power, water, demand, milestones → **M3**
- Save/load UI, notifications, audio, tutorial → **M4**
- Terrain *tools* (raise/lower interaction) — the **diff container** ships in M0 (T2.4), the tool itself is M1
- Service worker / offline cache → **M5**

---

## 16. Phase M1 — Build

**Goal (§10 M1):** the player lays roads, paints zones, gets buildings, bulldozes — and the city survives a reload.

**Entry:** M0 T1–T4 are complete (map, camera, renderer core, all measured). M0 stopped before T5–T7 (§15.2). M1 pulls forward only the two of those it actually needs and leaves the rest for M2/T7.

**Exit artifact:** a build that boots to the generated map, lets the player lay a small road grid and zone it, shows buildings appear, and restores all of it from IndexedDB on reload.

### 16.1 Scope decisions (user, 2026-10-28)

| Decision | Choice | Why |
|---|---|---|
| Money | **Free build.** No funds, no per-tile cost, no refunds | §6.7's economy is M3 and M1's exit criteria says nothing about balance |
| Persistence | **IndexedDB, one slot, versioned** | Keeps §6.12's storage choice, so the save format is not rewritten later. Multi-slot rotation, autosave cadence and `.cityscope` export stay in M4 |
| Building spawn | **Instant** on a zoned tile with road access | §6.4's demand/land-value gating needs §6.8, which is M3 |
| Zoom keys | **Move off `1`–`4`** to wheel + `-`/`=`, freeing `1`–`9` for the tool bar | Settles the conflict §15.2 T4 flagged against §6.2 |

### 16.2 Deliberate deferrals (recorded, not forgotten)

Things §6 asks for that M1 will **not** do, so a later pass reads the gap as a decision rather than a bug:

- **Roads are one 8 m tile with a 4-bit neighbour mask**, not §6.1's two tiles (16 m). §6.3's road classes (avenue / one-way / highway), spline placement, curvature preview and auto-intersections are M3/M5. A two-wide, directed road network is not a refinement of this code — it is a different placement model, and the exit criteria asks for the cheap one.
- **Buildings are one tile**, one of a handful of procedural variants per zone family. §6.4's 1→5 level-up, multi-tile footprints and abandonment-on-failure are M3.
- **No terrain tools.** §6.1's flatten / raise / lower / water is out. The save format keeps `World`'s terrain-edit slot (T2.4, §15.2) rather than removing it.
- **No demand, jobs, land value or happiness** (§6.8 → M3). The HUD's demand bars and the date/speed fields stay **placeholders, labelled as such**, rather than being filled with invented numbers.
- **No agents.** Nothing moves in M1 (§6.5 → M2). M1 is edit-driven, which is also why it does not need M0's 8 Hz loop.

### 16.3 Task list

#### T1 — City data layer
- [x] **T1.1** `City` in `src/world/city.ts`: `zone` / `road` / `building` `Uint8Array`s over the same 512² grid as `World`, plus a dirty-index set. SoA, no per-tile objects (§7). `road[i]` is `0` for none and otherwise `1 + mask`, because an isolated road (mask `0`) and no road would otherwise be the same byte; the mask is world-space, not display-space, so rotation cannot change a city's hash.
- [x] **T1.2** Zone families (R / C / I) and the edit API — `paintZone`, `placeRoad`, `bulldoze`. Every edit re-evaluates the tile **and its four neighbours**: a road changes its neighbours' masks, and removing one can orphan their buildings. All three funnel through one `reevaluateAround` so there is no fast path that is also a wrong path.
- [x] **T1.3** The building rule in one place: a tile carries a building **iff** it is zoned, has at least one road neighbour, its terrain is not water, **and it is not itself a road**. The variant is a deterministic hash of the tile index and the world seed (`Math.imul` mixing only, per §15.2 T2.1) — same seed, same city, and the same city again after a reload. **The extra fourth clause is forced by the data model**: zone and road are separate arrays, so a tile can be both, and without the clause a road drawn through a zoned block grows a house under it. Reading it as "a road tile carries no building" also means bulldozing only the road brings the building back with no extra state to keep in sync.
- **Verify:** painting the same sequence twice yields byte-identical arrays. → **passes**, see below.

**T1 results (2026-10-28):** `npm run typecheck` exits 0. Driven headless over CDP against the dev server's module graph (512², seed `20261028`): the same edit sequence twice — 20 road tiles, a 17×17 zoned block over them, two bulldozed roads, both axes of the map border, and one zoned water tile — yields byte-identical `zone`/`road`/`building` arrays and the same content hash (`47a3b9ae`). **13/13 checks.** Independently recomputed, every road byte equals `1 +` its true mask (0 mismatches); the building rule holds exactly in both directions (31 buildings, 0 violations, 35 → 31 after the two bulldozes); a zone family round-trip returns the identical bytes (`47a3b9ae → 7fa027b5 → 47a3b9ae`), which is the derivation claim checked rather than assumed; variants use all four values; the dirty set drains to empty.

#### T2 — Persistence
- [x] **T2.1** `src/world/save.ts`: IndexedDB, one object store, one slot, a `version` field, and a `load`/`save` pair. Zone and road arrays are stored as-is (structured clone carries typed arrays). **Buildings are not stored** — they are derived, so reloading recomputes them and there is one less thing that can disagree with the rule in T1.3.
- [x] **T2.2** Autosave, debounced after the last edit, plus a save on `pagehide`. 800 ms debounce; `pagehide` rather than `beforeunload` because it is the one mobile Safari honours.
- [x] **T2.3** Boot path: if a compatible save exists, apply it; if its seed differs from the world's, **discard it and say so** rather than merging two different maps. `loadCity` returns a `LoadOutcome` whose discriminated union carries the reason (`version` / `seed` / `size` / `shape` / `error`) and a message. A rejected record is **not deleted**: refusing to use it is recoverable, destroying it is not.
- **Verify:** reload restores the identical city. → **passes**, see below.

**T2 results (2026-10-28):** `npm run typecheck` exits 0. A two-phase CDP harness against the dev server: phase 1 paints a block, writes it, exercises the debounce and the `pagehide` handler; then the page is **hard-reloaded** (`Page.reload`), so nothing but IndexedDB survives; phase 2 re-reads from the fresh page and compares against the arrays embedded in the phase-1 result. **23/23 checks**, content hash `72460de2` before and after the reload — which is T1.3's "buildings are derived" claim tested across a process boundary rather than assumed. The harness also verifies each discard path (version, seed, size, shape) is rejected with its reason and that an empty slot reports `empty` rather than throwing.

#### T3 — Atlas additions
- [x] **T3.1** Extend `src/render/atlas.ts`: road frames (16 neighbour-mask variants, drawn iso-aligned), zone tint diamonds (R / C / I), and procedural building frames (a few shaded iso boxes per family with window detail). Still generated at boot, still zero asset weight (§15.2 T3.1). Four bands in one 1024 × 152 texture — terrain `0`, road `TILE_H`, zone `2 × TILE_H`, building `3 × TILE_H` — with the building band `BUILDING_RISE` rows taller than a tile so a box can stand above its footprint (`BUILDING_FRAME_H = 56`). Road frames are indexed by the **display-space** mask, so T5 must call `rotateMask` first.
- **Verify:** one texture, inside the 2048² cap. → **passes**, see below.

**T3 results (2026-10-28):** `npm run typecheck` exits 0. CDP harness reads the sheet canvas back with `getImageData` and inspects real pixels. **20/20 checks.** 1024 × 152 px in one texture, frame counts 6/16/3/12, tile-sized terrain frames and 64 × 56 building frames, every frame rectangle inside the sheet, and `sheetTotal === frameTotal` (36,846 px) — nothing is drawn outside a frame. Every frame is non-empty, each road arm paints only its own screen quadrant (probed at ±⅔ along the arm axis, with N = up-right and W = up-left), `mask 0` is a bare hub, and `N|S` / `E|W` are longer than either single arm, i.e. straight carriageways exist. The four building variants have distinct heights in `VARIANT_RISE` order `[16, 22, 12, 19]` and the three families differ in roof colour.

**Two real defects this harness caught**, both of which looked fine by eye and would have shipped:

1. **North and west road arms were swapped.** `ROAD_ARMS` had N at up-left; `City.maskAt` puts `MASK_N` on the `z - 1` neighbour and `MASK_E` on `x + 1`, and `chunkLayer.walkTiles` projects those to up-**right** and down-**right** respectively. The old order made `N|E` the straight pair, so every axis-aligned road would have drawn as a dogleg — while the tiles still looked plausible individually. The table in `ROAD_ARMS`' doc now records the derivation, and the harness probes quadrants rather than trusting the picture.
2. **The road plate covered the whole tile.** `drawRoad` filled the full `TILE_W × TILE_H` diamond before stroking the arms, which left all sixteen masks looking nearly identical (1088 px vs 1106 px) — a road network would have rendered as a paved plaza. The plate is now an `11 × 5.5` junction hub: the arms carry connectivity, the hub fills the junction and gives `mask 0` (an isolated stub) something visible. Coverage now spreads from 144 px (hub only) to 792 px (full cross).

#### T4 — Tile picking
- [x] **T4.1** Screen → world tile. The camera root is a pure translate + scale, so the inverse is arithmetic rather than a matrix read: screen px → base px → display tile → `tileFromRotated` → floor, with a map-bounds guard. `WorldRenderer.pickTile` reverses the translate and the scale, solves `basePx = rx·u + rz·v` for the rotated-grid basis `u = (HALF_W, HALF_H)`, `v = (−HALF_W, HALF_H)`, then **rounds** (a tile's integer coordinate is its centre, not a corner) and un-rotates. Off the map it returns `null` rather than a clamped or wrapped tile. It reads the transform as last applied by `update()`, so the answer is the tile *drawn* under the point, not the tile a pending camera change implies.
- **Verify:** the picked tile is the tile drawn under the cursor at all four rotations and all four zoom steps. → **passes**, see below.

**T4 results (2026-10-28):** `npm run typecheck` exits 0. CDP harness against the dev server, **30/30 checks**, 1600×900. Per rotation, nine spread tiles (centre, three corners, the four edge midpoints) round-trip through the picker to the same world tile; four points inset 45 % of the way to each vertex stay on the tile, and a one-rotated-step offset picks the `+x` neighbour — 0 failures of 9 / 36 / 9. Then the claim that actually matters: at **all four rotations × all four zoom steps**, a 17 × 11 lattice of screen points is swept and for every point the picker must name a tile whose drawn diamond contains the point *and* no tile in the 3×3 neighbourhood of that pick may contain it — 187 points per combination, **0 off-tile and 0 ambiguous in all sixteen combinations**, i.e. the pick is both correct and unique. A display-space cell 20 tiles outside the grid on either side yields `null`, and the corner tile `(0, 0)` itself is pickable.

The harness reads the camera root's actual `position` off the scene graph (`view.layers.terrain.parent`) rather than recomputing it, so the transform being inverted is the one the renderer applied. Its first run failed 13 checks outright — the harness had captured `pixelScale` once at boot, so every combination except the default zoom was projected with the wrong scale. The picker was right; the measuring stick was wrong, which is why the check now reads the scale per call.

#### T5 — City render layer
- [x] **T5.1** `src/render/cityLayer.ts`: fills the reserved `zones` / `roads` / `buildings` / `overlays` containers from `City`'s dirty set — one sprite per tile, keyed by tile index, repositioned on rotation. The `zones` band sits between terrain and roads in §7's order, because a zone tint has to go *under* the road on a tile that is both zoned and paved, and under any building. `sync(rotation)` is called once per frame by the owner of the ticker (`main.ts`, after `view.update()`); presence is decided from the arrays rather than from what is already on screen, which is what makes "bulldozing leaks no sprite" structural instead of something to remember. A `null` frame removes the sprite; a rotation is the only full pass, because only a rotation moves which tile is drawn where. Sprites sit in **base pixels** under the camera container, so panning costs nothing here, and building sprites are lifted by `BUILDING_BASE_OFFSET` (a building's frame is taller than its tile, so it is placed by its base, not its centre). Road frames run `rotateMask` before every atlas lookup, since the stored mask is world-space.
- [x] **T5.2** Hover highlight and the active tool's ghost preview on `overlays`. The ghost shows the frame the tool would place — the bare junction hub for a road, because the real mask depends on neighbours that do not exist yet; nothing for bulldoze, where the highlight *is* the preview. The highlight strokes `#bfeadb` when the tool would change the tile and `#e0726c` when it would be a no-op, so "nothing happened" is distinguishable from "the click missed".
- **Verify:** the drawn city matches the arrays, and bulldozing leaks no sprites. → **passes**, see below.

**T5 results (2026-10-28):** `npm run typecheck` exits 0. CDP harness against the dev server, **33/33 checks.** It plants a real city on flat land near the centre — a 7-tile road, a 6 × 2 residential block beside it, and one tile that is **both** zoned and paved — then lets the **rAF ticker** drive the layer rather than calling `sync` by hand, so the wiring is what is being measured. Sprite counts equal the arrays' tallies exactly (13 zoned / 7 road / 6 built, and the "row two tiles from the road gets no building" case holds). Then the strong form of the claim: at **all four rotations**, each band's drawn set is compared tile by tile against the data — for every tile that should carry a sprite there is one at that tile's own display position, in the right band, anchored 0.5, with the frame the data indexes (`state.zoneFrameIndex` / `rotateMask(roadMask)` / `buildingFrameIndex`), and there is no sprite whose position is not a built tile's: **0 missing, 0 extra, 0 wrong-frame, 0 wrong-anchor, 0 wrong-parent in all twelve band × rotation combinations.** The camera turning does not mutate the city (hash `f41472ec` before and after the rotation loop), which is T1.1's world-space-mask claim checked with the renderer attached.

Overlays: the ghost is present and framed for the selected family (residential frame x `0`, industrial `128`), positioned on the hovered tile, and parented in `overlays` — the last band in the camera container. The highlight's stroke colour is read out of the Graphics context and is exactly `#e0726c` on a no-op (road tool over an existing road; zone tool over an already-residential tile) and exactly `#bfeadb` where the tool would change the tile, and its bounds centre lands on the hovered tile's screen position to 0.0 px (diamond 67.4 × 35.4, i.e. a 64 × 32 tile plus the 1.5 px stroke). Bulldoze shows no ghost; hovering off the map hides both. An idle frame leaves `dirtyCount === 0` and adds no sprites across repeated frames — no per-frame churn. Bulldozing the road line empties the roads band, drops the six now-orphaned buildings to zero sprites and keeps the zones; bulldozing the rest empties all three bands with no sprite left in the scene graph.

The harness's first run was **30/33**, and the three failures were all in the measuring stick: two because a stroke instruction carries its path, which points back at its own Graphics context, so `JSON.stringify` of the instruction list returned nothing — the colour is now read directly off the last stroke's style and checked against the literal expected values; the third because `getBounds()` is in stage space while a sprite's `position` is in camera-container space, so the harness was comparing two different frames of reference. The layer was correct in all three.

#### T6 — Tools & pointer input
- [x] **T6.1** Tool state machine in `src/ui/tools.ts`: cursor / road / zone R / zone C / zone I / bulldoze, plus `Esc` back to cursor. A tool is one `Tool` record holding both its **preview** and the write it performs, so the ghost the player sees and the byte a click writes cannot drift apart; `TOOLS` is the table and adding a tool is adding a row. `select()` pushes the record's preview into the layer, so the ghost is never switched separately from the tool. Slots `1`–`6` select by digit, `T`/`R`/`C`/`I`/`B` are the letter aliases, and `Esc` is the cursor.
- [x] **T6.2** Pointer routing: with a build tool active the **left** button paints and the **middle** button still pans; with the cursor tool both pan (today's behaviour). Drag paints along a line. `ToolController.buildMode` is the single source of truth and `CameraInput` *asks* it (`isBuildMode`, read per press) before claiming the left button, so the two layers cannot both take the same press. The hovered tile is re-picked every frame rather than only on `pointermove`, because panning under a still pointer changes the tile; the layer is written only when the tile actually changed. A drag joins consecutive sampled tiles with Bresenham, so a fast drag paints a line instead of the two tiles the pointer happened to land on.
- [x] **T6.3** Move zoom to wheel + `-`/`=`, and take `1`–`4` off zoom in `src/ui/input.ts` (§16.1). The `1`–`4` cases were deleted and replaced by `-`/`_` and `=`/`+`; the wheel was already a full substitute.
- **Verify:** every tool is reachable from the keyboard alone, and middle-drag still pans while a tool is active. → **passes**, see below.

**T6 results (2026-10-28):** `npm run typecheck` exits 0 (one fix on the way: `main.ts` still imported the unused `type ToolId`, which `noUnusedLocals` rejects). CDP harness against the dev server, **47/47 checks**, 1600×900 — every key and every pointer event dispatched through Chrome's real input pipeline (`Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`) and hit-tested by the browser, so the DOM listeners themselves are what is under test rather than the classes being called directly.

Keyboard reachability: `Esc` returns to the cursor from all six tools, each of `1`–`6` selects its tool, and each of `T`/`R`/`C`/`I`/`B` selects its tool — twelve checks, all from a single keydown with no pointer involvement. An unbound letter (`z`) and an unbound digit (`9`) leave the active tool alone. The ghost then follows the keyboard alone: selecting road with `2` and *hovering* (no click) shows the hub frame, and selecting zone C with `4` swaps it to the commercial tint (`frame.x` 64) on the same hover.

Routing: with the cursor tool a left-drag moves the camera (root `800,-4905.5` → `672,-4969.5`) and the content hash is **unchanged**, so the pan painted nothing. With road active the same left-drag paints (0 → 5 road tiles) and the camera root is **bit-identical** before and after. The §16.3 verify line specifically: with road still active a **middle**-drag moves the camera (`800,-4905.5` → `608,-5001.5`), paints nothing (hash unchanged), and leaves the build tool active. The cursor tool's middle-drag pans too, so that route never regressed.

Drag-as-a-line: road is cleared, then a press on one tile and a **single** sampled move to a tile 6 × 5 away, released. The pointer was sampled twice, so a per-sample painter would have left two tiles; instead **exactly the reference Bresenham line is painted — 7 tiles on the line, 7 painted, 0 off the line** — and the run is one connected piece with 0 isolated tiles, so nothing between the two sampled ends was skipped. The camera again did not move. The bulldoze tool writes through the same path (a left click on a painted tile took the count 7 → 6).

The harness's first run was **40/46**, and every failure had one cause: the checks clicked tiles that project **off the viewport** at the default camera, and Chrome hit-tests dispatched mouse events, so the events never reached the canvas — the projection arithmetic still answered, which made it silent. The harness now centres the camera on its land block and asserts the computed points are on screen before clicking. The remaining two were honest: one expectation was simply wrong (a three-point drag paints a path, not two tiles — the exact-set check lives in the drag test), and one **corrected a false comment in the product**. `tools.ts` claimed consecutive Bresenham tiles are 4-neighbours; they are not — standard Bresenham advances both axes in one step, so a diagonal drag paints a diagonal and the run is **8-connected**, not 4-connected. The behaviour is the right one (a straight drag should be straight, and widening it into a staircase would paint tiles the player never traced); the comment was rewritten to say what the code does, and the check asserts the property that actually matters, that no tile between the sampled ends is skipped.

#### T7 — Tool palette & HUD
- [x] **T7.1** DOM tool palette and HUD frame — this is M0's **T5.1**, moved here: the §6.11 fields (money, population, date, speed, demand bars, notification badge), with the ones M1 cannot compute marked as placeholders. The HUD is **DOM, not a PixiJS `Text`**: it must not pan or scale with the camera, and the palette buttons have to be real clickable elements. `src/ui/hud.ts` builds the palette by walking `TOOLS` — the same table the keyboard reads — and a click calls the same `select()` a hotkey does, so there is one description of what a tool is and one route to activating it. `#hud` is `pointer-events: none` apart from `.hud-tool`, so a HUD that sits over the canvas cannot swallow a paint drag beneath it (T6.2).
- [x] **T7.2** Wire the fields M1 *can* compute: population from the building count, plus a road/zone/building tally feeding the debug readout. Population is `layer.stats.buildingSprites` — the count the map was drawn with, not an invented multiplier or a stored figure. The fields M1 cannot compute (money, date, speed, demand, alerts) render `—` with `data-placeholder="true"`, which turns "this is not a number yet" into a property a check can read; demand stays three empty meters rather than three filled bars. The readout carries the tally line `city tally — zones N · roads N · buildings N · population N`.
- **Verify:** hotkeys and clicks select the same tool, and the HUD never presents a number M1 did not compute. → **passes**, see below.

**T7 results (2026-10-28):** `npm run typecheck` exits 0. CDP harness against the dev server (`/tmp/city-t7-check.mjs`, since deleted — the harness deliberately lives outside the deliverable), **44/44 checks**, 1600×900, driven through Chrome's real input pipeline so the DOM listeners are what is under test.

One route, two input paths: the palette is generated from `TOOLS` in slot order and every entry is a real `<button type="button">`; cursor is active at boot with exactly its button highlighted. Clicking each of the six buttons, pressing `1`–`6`, and pressing `Esc`/`T`/`R`/`C`/`I`/`B` each select that tool and leave **exactly one** highlight — all **18 selection events agree**, so "hotkeys and clicks select the same tool" is checked, not asserted. `buildMode` tracks the active tool, and the palette interaction left the camera root bit-identical (`800,-7785.529411764706` → same) and painted nothing, i.e. operating the HUD does not disturb the world.

Never a number M1 did not compute: the placeholders are money / date / speed / demand / alerts, and **no placeholder's value contains a digit** — money/date/speed/alerts are the literal `—` and demand is three `.hud-bar` elements with an **empty** value string. Population is the only computed field, it is not a placeholder, and it equals the data tally both before (`0`) and after building (HUD `4` · `{roads 6, zones 4, buildings 4}`), so the panel and the arrays cannot disagree.

HUD does not steal input: the computed styles are `#hud` → `pointer-events: none`, `.hud-readout` → `none`, and only `.hud-tool` → `auto`. The specific claim, re-verified after the harness was deleted with a throwaway inline CDP probe (no file written): a **paint drag that starts under the HUD readout still reaches the canvas** — point `(1289.18, 86.02)` genuinely inside the readout rect `{left 1159.41, top 8, right 1592, bottom 181.375}`, with `buildMode: true`, took roads `0 → 2` and the content hash `df8c9dc5 → db134f69`.

**Honest note on the measuring stick.** The deleted harness's first run reported this same check as passing **vacuously**: it computed the drag pan as `panByScreen(target − point)`, but `panByScreen` moves the *camera*, so the drawn content moves by the **negated** delta. The probe therefore drove the target tile *away* from the readout (trace ending `(−2420.8, 6796)`, `inside=false`) and the drag painted nothing — a false pass, not a false failure. Negating the delta — `panByScreen(point − target)` — converges in one step (`800,406.5 → 1289.2,86.0`, target `1289.184375,86.01875`). The same sign error is why the harness's note read `readout drag point not inside the panel (inside=false)`; the corrected probe above is the evidence that replaced it. `no uncaught error or rejection: true`.

#### T8 — Boot feature-detect (absorbs M0's T5.4)
- [x] **T8.1** `src/core/capabilities.ts`: test WebGL2 and Web Worker availability before anything else is constructed. → `boot()`'s **first statement** is `detectCapabilities()`, ahead of `new World()` and ahead of the PixiJS application; when `ok` is false it shows the screen and returns without constructing anything. Nothing in the guard touches PixiJS, which is the point — it has to run precisely when the renderer cannot be created. WebGL2 is probed on a throwaway canvas that is immediately dropped (browsers cap live contexts); `Worker` is a `typeof` test.
- [x] **T8.2** A clear unsupported-browser screen when either is missing — **no Canvas2D blitter** (§14.7 closed, §4 updated). → `showUnsupportedScreen` builds plain DOM — `main.unsupported` with a title, the missing-capability list and one line of advice — and its CSS now lives in `index.html` (it was the one piece T8 had left unfinished). No blitter was written; §14.7 stays closed and the screen *is* the fallback.
- **Verify:** forcing the detection to fail shows the screen, not a black canvas. → **passes**, see below.

**T8 results (2026-10-28):** `npm run typecheck` exits 0. Driven headless over CDP, 1600×900, three scenarios in one run — each capability forced to fail **on its own**, plus a control. The failure is injected with `Page.addScriptToEvaluateOnNewDocument`, which runs before any page script, so it is the real `detectCapabilities()` being defeated and not a mock: no-WebGL2 stubs `HTMLCanvasElement.prototype.getContext` to return `null` for `webgl2`, and no-Worker defines `window.Worker` as `undefined`. **13/13 checks.**

Both failure scenarios produce `main.unsupported` with the title *"CityScope cannot run in this browser"*, the capability named in the list (`• WebGL2` / `• Web Workers`), the advice line, `display: flex` and a non-zero box (i.e. laid out, not a hidden node) — and **no `<canvas>`, no `#hud`, and no `window.cityscope`**, which is the "not a black canvas" half of the verify stated positively: the renderer was never constructed, so there was nothing to go black. The control run boots normally: no screen, canvas present, HUD present, `autosave` wired, and the readout's `save` line present. No uncaught exception or rejection in any of the three.

#### T9 — Boot wiring: persistence
> Added because §16.4's verify cannot pass without it, and it turned out to be genuinely missing: `save.ts` shipped and passed T2's own checks, but **nothing called it from `boot()`** — T2's harness drove `loadCity`/`Autosave` directly through the module graph, so a product that never autosaved still passed T2. The gap was only visible from the phase-level verify.
- [x] **T9.1** Call `loadCity(world, city)` at boot, **before** `CityLayer` and `Hud` are constructed, so the first sync already sees the player's city instead of an empty grid that fills in a frame later, and the first readout can report what loaded. A `discarded` outcome is warned to the console; all outcomes are printed on the readout as `save <status> — <message>`, which is T2.3's "say so" made visible rather than console-only.
- [x] **T9.2** Construct `Autosave(() => snapshot(world, city))` and `attachPagehide()`. `ToolController` gained an optional `onEdit` hook, called from `write()` only when a writing tool actually wrote — never for the cursor tool — so a stroke schedules per tile and the 800 ms debounce is what collapses it into one write (T2.2).
- [x] **T9.3** Expose `autosave` on `window.cityscope`, so §16.4's check can flush deterministically instead of racing the debounce.
- **Verify:** §16.4's phase check passes end to end. → **passes**, see below.

### 16.4 Verify (phase level)

> **Build a small grid city through the UI, reload the page, and get the identical city back.**

Concretely: lay a road loop, zone the blocks inside it, confirm buildings appear on road-adjacent tiles **only**, bulldoze part of it, hard-reload, then compare the recovered zone/road arrays against the pre-reload ones.

**M1 phase verify (2026-10-28): passes, 17/17 checks, `npm run typecheck` exits 0.** Headless Chrome over CDP, 1600×900, a fresh browser profile so the IndexedDB slot starts genuinely empty. Every action goes through the real input path — tool selection is a real mouse click on a T7 palette button, and building is `Input.dispatchMouseEvent` press/move/release, hit-tested by the browser — so this exercises the DOM listeners, not the classes.

*Empty start.* Boot reports `save empty — no saved city` on the readout, and the arrays are all zero (content hash `df8c9dc5`, every count `0`).

*Build.* A 9 × 9 all-land block is found by scanning outward from the map centre and the camera is centred on it; all 81 projected points are asserted on-screen before anything is clicked (the failure mode T6's harness hit). A **road loop of 32 tiles** is laid as four straight drags around the perimeter, then the **interior 7 × 7 is zoned** as seven row drags. The result is exactly what T1.3 predicts: **24 buildings**, precisely the ring of interior tiles that touches the loop, and **0 buildings in the inner 5 × 5** — no road neighbour, so nothing grows. Independently recomputed from the arrays, **no building in the block lacks a road neighbour (0 orphans)**.

*Bulldoze.* Three road tiles in the middle of the top edge are removed. Roads `32 → 29`, zones stay `49`, buildings `24 → 21` — the three interior tiles that had those tiles as their *only* road neighbour drop their building, while the zoning stays. That is the derived-building rule (T1.3) doing the work: nothing about the buildings had to be tracked.

*Reload.* The slot is flushed, the page is **hard-reloaded** (`Page.reload`, `ignoreCache`), and the fresh page is compared against the arrays captured before. Identical **content hash**, identical zone/road/building counts, and identical **per-array digests** — a `Σ index × prime` checksum, so this is order-sensitive and not merely a totals match. The reloaded counts are still `49 / 29 / 21`, i.e. the building **derivation ran again from the restored arrays** rather than a stored copy being trusted (T2.1's claim, tested across a process boundary). The readout says `save restored …`, and the **layer's sprite tallies equal the arrays**, so the recovered city is actually drawn and not just present in memory. No uncaught exception or rejection in either page.

*Two harness bugs on the way, both mine.* The empty-city assertion expected hash `00000000`, but `contentHash` seeds at the FNV offset basis, so an all-zero city hashes to `df8c9dc5` — the expectation was wrong, the product was not. And `Page.reload` invalidated the evaluate that followed immediately behind it (`-32000 Inspected target navigated or closed`); the fix is to await `Page.loadEventFired` before evaluating, which is a measuring-stick fix rather than a product one.

### 16.5 What M1 does not close

§15.6's exit criteria — the §15.5 evidence table, the floor device, §15.4's rotation and preset picks, the 8 Hz drift check — remain open and belong to M2/T7. M1 adds a workload that no M0 number covers yet; that is what M2's entry scenarios (T7.4) are for.

---

## 17. Appendix

**Glossary:** *RCI* residential/commercial/industrial demand · *SoA* struct-of-arrays · *LOD* level of detail · *O-D pair* origin-destination · *A/B toggle* two implementations selectable at runtime so a decision can be measured instead of assumed · *floor device* the oldest machine still on the support list (§4).

**Reference comparisons:** Cities: Skylines (systems depth, agent model), SimCity 2000 & Transport Tycoon (isometric rendering target), Islanders (web-scale budget), Tiny Glade (modular sprite assembly).

**Document history**

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-28 | Initial draft; §13 decisions resolved |
| 1.1 | 2026-10-28 | Consolidated three docs into one. Merged the Track A spike (§14) and the M0 phase plan (§15). `spike/` deleted unmeasured (Q6); app hoisted to repo root; M0 rewired to carry the performance verdict itself (T3.2/T3.4/T3.6 now build both options; new risk R8) |
| 1.2 | 2026-10-28 | M0 stopped after T4 (verified, 22/22) and M1 started (new §16). M0's T5–T7 parked: T5.1 → M1 T7, T5.4 → M1 T8, T5.2/T5.3 → M2, T6/T7 → after M2. §14.7's Canvas2D question closed by decision — no blitter, unsupported-browser screen instead (§4, §15.5, §16 T8). §15.4's chunk-strategy pick recorded as `cached` |
| 1.3 | 2026-10-28 | M1's task list closed: T1–T8 implemented and verified (T1 13/13, T2 23/23, T3 20/20, T4 30/30, T5 33/33, T6 47/47, T7 44/44, T8 13/13), plus the §16.4 phase verify (17/17). New §16.3 **T9** added to close a real gap the phase verify exposed — `save.ts` had passed T2 but nothing called it from `boot()`, so the product never autosaved. T7 recorded with an honest note on a vacuous pass caused by a harness `panByScreen` sign error |
