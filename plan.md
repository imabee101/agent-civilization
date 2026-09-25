# LLM War — build specification for a fresh implementation

This is a spec for an agent picking this up with no prior context, describing what the human collaborator actually wants, distilled from a long back-and-forth where earlier attempts kept drifting back toward the thing being explicitly rejected.

## The core idea

A shared virtual world where multiple LLM agents (small local/self-hosted models, e.g. ~3B parameters, run via Ollama/llama-server) each control one character/node. The point of the project is to watch what happens when autonomous models are put in a shared space with each other with as little imposed structure as possible. It's a game in the sense that it's visual, fun to watch, and has stakes (survival), not in the sense of having designed rules for how characters must interact.

## The failure mode to avoid, stated plainly

Every previous iteration relapsed into the same mistake: building a fixed menu of actions (`Action::Attack`, `Action::Invite`, `Action::Declare` war/peace/alliance, `Action::Steal`, etc.), a fixed set of relationship/faction mechanics, and engine code that decided outcomes on the agents' behalf (auto-starting wars on first strike, auto-accepting or auto-refusing alliance proposals based on a hidden opinion score, auto-feeding starving agents, forcing a "coward" flee reaction on low HP, having a heuristic brain pick from a weighted probability table). Each time this was pointed out, the fix applied was narrower than the complaint: remove one gate, add a consent-based replacement gate, remove that too, etc. That whole pattern is wrong. The instruction was never "adjust which rules govern agent interaction" — it was "there should not be engine-authored rules governing *how agents are allowed to interact with each other* at all." The only legitimate rules are physical/survival constraints (an agent can't eat food it doesn't have, can't be heard from far away, dies without food), never social ones (who can ally with whom, what counts as betrayal, whether an attack "counts" as a war declaration).

Do not build: a fixed `Action` enum of social moves, faction/relationship/reputation data structures maintained by the engine, any function that decides how one agent's action affects another agent's state without that second agent's own code/model being the thing that decided it, any automatic detection→consequence pipeline (e.g., "if caught hacking, war is auto-declared"), any narrator or event-text system that puts words in agents' mouths, any heuristic/mock brain that scripts behavior via weighted probabilities meant to produce "interesting" outcomes.

## What to build instead: agents as self-owned, self-scriptable nodes

Each agent is not "a character with an action list" — it is a small computational node that the agent's own model configures and programs.

- Each agent owns a private space: its own small virtual filesystem/config and its own script (e.g. `main.js`) that it can read and rewrite.
- On each turn, the model is shown its situation and can respond with real code (JavaScript) that executes immediately against its own node — not a choice from a fixed action list.
- The model can also install persistent handlers in its own script (e.g. an `onTick()` and `onMessage(from, msg)` function) so the node keeps behaving between the (comparatively rare/slow) model-generated turns.
- Agents interact with each other only through a tiny set of primitives the world exposes, not through any modeled "relationship" or "faction" system:
  - perceive/observe self and surroundings
  - move/act on your own body (survival actions: eat what you're carrying, gather, etc.)
  - speak (locally audible) / send a message to a specific other node
  - read/write your own files
- What a message *means*, whether it's trusted, whether it triggers cooperation, betrayal, trade, grouping, hierarchy, hacking-each-other's-node, whatever — is entirely determined by the receiving agent's own code/model, which it wrote. If an agent writes sloppy/naive code (e.g., blindly executes instructions it receives from another node), it can be exploited by another agent that figures that out. If an agent wants to invent factions, alliances, currency, chat protocols, betrayal, sabotage — it has to build those itself, in its own code, not use engine-provided verbs for them. The engine must never contain words like "faction," "war," "alliance," "invite," "steal," "sabotage," "hack," or "backdoor" as first-class mechanics — nothing that sounds like a built-in malicious-action system, since the framing must stay "this is a game," not "this is a cyberattack simulator." Emergent adversarial behavior between agents (if it happens) must emerge from what agents choose to write in their own code, not from any engine feature that is *named or flavored* as hacking/malice.
- Survival is real and is the only "forcing function": hunger/energy drain over time, running out of food kills the agent, a dead node is left behind (ruin) with its files/code intact for others to find/read/reuse later. This is the "natural selection" mechanic the collaborator wants — agents that don't play well (don't secure food, don't cooperate, don't defend themselves) die out; agents that do, persist. That selection pressure must come only from the survival loop, never from engine-adjudicated combat/social outcomes.

## The sandbox boundary (the one place strict engineering is correct)

- The *outer* sandbox — protecting the real host process, filesystem, network from agent-authored code — must be airtight and proven with adversarial tests: memory limits, execution/instruction limits, stack limits, no filesystem/network/timer access from inside agent code, only the explicit host-bridge primitives reachable, quotas on each agent's virtual file storage and message size.
- The *inner* boundary — one agent's node vs. another agent's node — is deliberately NOT engine-secured. Whatever an agent exposes via its own `onMessage` handler is exactly as secure as that agent's own code makes it. This is where all the "mess with each other" fun is supposed to live, entirely opt-in and author-controlled by each agent, never scripted or guaranteed by the engine.
- Recommended sandbox mechanism: an embedded QuickJS interpreter (WASM build, e.g. `quickjs-emscripten`) per agent, one fresh runtime/context per node, memory/stack/interrupt limits set, only a small explicit set of host functions injected in.

## Stack

- Bun + TypeScript end to end: the server (WebSocket + REST + serving the UI), the world simulation, the sandbox runner, and the web frontend, all in one language/runtime.
- Compiles to a single self-contained Bun binary (`bun build --compile`) for easy hosting — no separate Rust build, no separate Vite/Node build step at deploy time.
- Brain backends: any OpenAI-compatible local/self-hosted endpoint (Ollama, llama-server, LM Studio), plus a genuinely non-scripted no-model fallback (e.g., uniform-random valid action/code snippet, used only as a baseline/when nothing else is configured — never authored to "make things interesting").
- Frontend: keep the existing look/feel (PixiJS hex-world rendering, the glassy/clean-but-elaborate/slightly cute UI, day-night cycle, minimap, event chronicle, "under the hood" nerd panel showing each agent's live code/files/raw model I/O, optional browser TTS narration of literal events/speech only — never AI-authored narration). Must work well and be full-bleed (no boxed/letterboxed map) on mobile portrait, tablet, and desktop, no overflow anywhere.

## Other standing requirements from the original brief, still valid

- Long-term engagement: the world should be able to run/persist over days-weeks-months (snapshotting/restore), with dead-agent ruins as a persistence/discovery mechanic across that timescale.
- Full "nerd mode" transparency: raw prompts/outputs, each agent's actual current code and files, performance/pacing stats, visible but not intrusive.
- Adaptive pacing based on measured inference speed (tokens/sec or decision latency) — real-time when fast, sequenced/queued when slow — implemented as a scheduling detail only, not as anything that changes what agents are allowed to do.
- Documentation, written after the system is built and working, should explain the design (especially the "no engine-imposed social rules, agents script themselves" principle) clearly and with personality, before any final commit.
- A light, careful, clearly-in-universe joke about small local models occasionally producing grandiose self-descriptions is welcome as flavor (e.g., an agent's own generated text happens to be funny/self-important), but this must never be engine-scripted, must never reference real companies/products, and must never be implemented as a "narrator" — if it happens at all, it only happens because it's literally what an agent's own model output was.

## Acceptance test for "did you actually build the right thing"

Before considering any milestone done, check: does the engine contain a single line of code that decides a *social* outcome for two agents (who's allied with whom, whether an attack means war, whether a message is obeyed, whether an invitation succeeds) rather than just exposing raw perception/action primitives and letting each agent's own code/model decide? If yes, that line is the bug, not a rule to be refined.

## UI specification (self-contained — do not need to consult any other branch)

The old implementation (on the `archive` branch, for salvageable reference only — its social-mechanics code must NOT be reused, only its visual system) had a UI that looked and felt right. This section captures everything needed to rebuild that look on the new node/message model, without opening `archive`.

### Visual language

Dark, glassy, "clean-but-elaborate with a little cute factor," never juvenile. A hex-tile world rendered full-bleed behind translucent floating panels (frosted glass: blur + saturation + soft border + soft shadow), not a bordered "app chrome" look.

**Design tokens** (CSS custom properties on `:root`):
```
--bg: #0a0d14                              page/canvas background
--panel: rgba(14, 18, 27, 0.72)            translucent panel fill
--panel-strong: rgba(14, 18, 27, 0.9)      panel fill where text must stay readable over the map (drawers)
--line: rgba(255, 255, 255, 0.08)          hairline border
--line-strong: rgba(255, 255, 255, 0.16)   hover/active border
--text: #e6e9ef                            primary text
--dim: #8b93a5                             secondary text / labels
--accent: #ffcf6b                          warm gold — active states, highlights, "important" events
--danger: #ff5c5c                          conflict/aggression color
--ally: #4fd1c5                            cooperation/friendly color
--font: 'Inter', system-ui, sans-serif      UI text
--mono: 'JetBrains Mono', ui-monospace, monospace   numbers, code, raw model output, timestamps
--display: 'Cinzel', serif                  wordmark + big ribbon titles only — used sparingly, not body text
--rail-w: 232px                             desktop left rail width
--chron-w: 300px                            desktop right rail width
```
Load `Inter` (400/500/600/700), `JetBrains Mono` (500), and `Cinzel` (600/700) from Google Fonts.

Base type is 13px. Labels are 10px, uppercase, `letter-spacing: 0.12em`, `font-weight: 600`, colored `--dim` — this small-caps label treatment is used everywhere (rail titles, bar labels, stat captions) and is a key part of the "clean" feel.

`.glass` utility class used by every floating panel:
```css
background: var(--panel);
backdrop-filter: blur(14px) saturate(140%);
border: 1px solid var(--line);
box-shadow: 0 10px 40px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04);
```

### Layout (desktop / tablet, ≥821px)

Everything except the canvas is `position: fixed`, floating over the full-bleed map — nothing boxes the map in.

- **`#stage`** — fixed, `inset: 0`. The PixiJS canvas. This is the entire background at all breakpoints.
- **Top bar** (`#topbar`, fixed top, 12px inset, 46px tall, rounded 12px, `.glass`): left-to-right — brand mark (small rotated conic-gradient "sigil" square + `Cinzel` wordmark in wide letter-spacing) — a vertical divider — a day/phase clock (small circular sun-arc SVG indicator + "Day N" in mono + phase name in `--dim`) — playback controls (pause/play icon button, then a segmented 1×/2×/4× speed switcher, active segment tinted `--accent`) — a stat cluster pushed to the right margin (`margin-left: auto`) showing live counters (e.g. agents alive, groups/nodes active, "thinking" count highlighted in `--accent`, avg decision latency in ms) — a pill-shaped brain/model badge (small pulsing dot: teal = connected, red/still = not, plus backend/model name in mono, plus a pacing indicator) — a right-aligned icon/text button cluster (narration toggle, "under the hood" toggle, spawn, reset).
- **Left rail** (`.rail-left`, fixed left, top 72px, width `--rail-w`, `max-height: calc(100vh - 220px)`, scrollable, background transparent — only the cards inside are glass): a column of cards, one per group/node-cluster the agents have formed (do not hardcode "faction" — this list should just be whatever groupings currently exist, which may be none). Each card (`.fcard`): rounded 10px, `.glass`-style translucent background, a 3px colored left edge bar with a matching glow (`box-shadow`) in that group's own color, an icon/emblem chip, name, member count in mono, a thin animated strength/progress bar, small meta stats, and small relationship chips — all driven by whatever state the agents' own code exposes about themselves, not by engine-tracked diplomacy. Dead/collapsed entries shown at reduced opacity + grayscale rather than removed, so their ruin is still browsable.
- **Right rail / chronicle** (`.rail-right`, fixed right, top 72px, width `--chron-w`, extends to bottom-12px, `.glass`, rounded 12px, flex column): a header row (small-caps "Chronicle" label + an "all" checkbox toggle to include low-importance events), then a scrollable event list. Each event row (`.ev`): a small icon tile on the left (rounded 6px, tinted by event category) and text on the right (the literal event text, small meta line in mono with day/tick, and — only for actual agent speech — the literal quoted words, never AI-authored narration of it). New rows slide/fade in. Higher-importance events get a subtle gold left-tint background band; category colors follow the semantic palette (aggressive/violent = danger red, cooperative = ally teal, creation/construction = accent gold, communication/code-execution = a cyan `#7ff3ff` accent) — but the category set itself must come from generic event kinds (spoke, moved, ate, died, sent-message, executed-code, node-created, node-joined-group, etc.), not from hardcoded war/alliance/theft kinds.
- **Selected-agent dossier** (`#dossier`, fixed, horizontally centered, anchored near the bottom, `.glass`, rounded 14px, rises in with a small translate+fade animation, closable with an ×): portrait chip, name + a colored group-tag chip, trait/tag chips, three side-by-side stat bars (health/food/energy-equivalents — gradient fills, thin 5px tracks), key/value rows (current goal, current action, inventory), a "live thought" area that shows the model's in-progress reasoning text with a blinking mono caret while streaming, and two columns underneath (recent memory log, relationships) as small scrollable lists.
- **Minimap** (`#minimap`, fixed bottom-left, `.glass`, rounded 10px, crosshair cursor) — small top-down render of the whole map with a viewport rectangle, click/drag to jump the camera.
- **Cinematic ribbon** (`#ribbon`, fixed, full-width, pointer-events none, hidden by default): for genuinely major moments only, two thin bars animate in from top+bottom edges (`height: 0 → 9vh`), revealing a centered `Cinzel` kicker/title/subtitle with a glowing horizontal rule that grows in from the center. Color-themed per event flavor (danger red for conflict, ally teal for cooperation, cyan `#7ff3ff` with a brief glitch/steps animation on the title for a code-execution/intrusion-flavored event). Triggered rarely — this is a "big moment happened" flourish, not per-event chrome. A `#vignette` (fixed, `inset:0`, pointer-events none, soft inset box-shadow darkening the screen edges) intensifies slightly during major-conflict moments for mood, then relaxes.
- **"Under the hood" drawer** (`#nerd`, fixed, horizontally centered, docked to the bottom, slides up from `bottom: -100%` to `bottom: 0` on a cubic-bezier ease, `max-width 1100px`, `max-height 62vh`, `.panel-strong` for readability over the map): a header with a tab switcher (small pill-group, e.g. "Brain" / "Nodes" / "Pacing" — rename from the old "Colony machines" tab since there's no colony mechanic anymore; this tab should show each node's live files/code) and a close ×. Body scrolls; monospace `<pre>` blocks for raw text (model prompt/output, file contents, code) get a subtle dark background, hairline border, rounded corners, and a max-height with internal scroll — tinted teal-bordered when healthy/ok and red-bordered when the last call errored. The "Brain" tab is a two-column layout: a scrollable list of recent decisions on the left (latency, agent name, a truncated preview of raw output — clickable), full prompt+raw-output detail on the right. The "Pacing" tab is a responsive tile grid (`repeat(4, 1fr)` down to `repeat(2,1fr)` on tablet) of small stat cards (label, big mono value, small caption).

### Layout (mobile / portrait, ≤820px) — the part that was explicitly broken before and must be gotten right this time

**The map must fill the entire viewport edge to edge at all times, including in portrait.** It must never appear as a landscape-shaped map letterboxed or boxed inside a portrait screen. Concretely:
- `#stage` stays `position: fixed; inset: 0` at every breakpoint — never resized or constrained by other panels; other panels float on top of it, they don't push or box it.
- The PixiJS camera/viewport logic must size and center itself against the actual current viewport aspect ratio (including portrait, where height > width), not against a fixed landscape aspect it then letterboxes — i.e., the "fit the world to the screen" zoom calculation must use `min(viewportWidth / worldWidth, viewportHeight / worldHeight)` against the *real* live `window.innerWidth`/`innerHeight` (or container size) every time it runs, including after an orientation change, and must re-run on resize/orientation-change events, not just once at load.
- No horizontal or vertical page scroll anywhere, at any viewport size — `html, body { overflow: hidden }`, and every panel's max dimensions must be computed from viewport units/`calc()`, never fixed px values that can overflow a small screen.
- The top bar shrinks (42px tall, tighter gaps/padding), non-essential elements hide (wordmark, phase text, the hint line, the stat cluster, the brain badge, secondary text buttons) so only pause/speed/essential icons remain.
- The left rail and right rail are hidden by default on mobile, and instead of floating simultaneously, become full-panel overlays toggled by a **bottom tab bar** (`#tabbar`, fixed bottom, `.glass`, rounded, a row of equal-flex buttons: World / Groups / Chronicle / Hood). Selecting a non-"World" tab shows that one panel as a near-full-width/height glass overlay (inset ~8px on all sides, positioned between the top bar and the tab bar) via a body-level state class; selecting "World" hides all overlays and shows just the map with the tab bar floating over it. This is how you get "map fills the whole screen" AND "full access to every panel" on a phone without boxing anything in.
- Minimap shrinks and repositions above the tab bar; dossier becomes a bottom sheet (full width minus small side insets, sits above the tab bar, internally scrollable, capped at ~55vh) instead of the floating centered desktop card; the "under the hood" drawer goes full-width/full-height-minus-tabbar instead of the centered 1100px desktop card; multi-column grids (dossier's memory/relationships columns, the nerd drawer's prompt/output columns, node-detail stat grids) collapse to a single column.
- Verify by actually loading the page at a phone viewport (e.g. 390×844) in both orientations and visually confirming zero clipped/overflowing elements and a map that reaches all four screen edges, not just by reading the CSS.

### Motion

Small, purposeful animation only — this is what makes it feel "quality" rather than static: event rows slide+fade in (~0.35s), the dossier rises in (~0.25s translate+fade), the nerd drawer slides up on a cubic-bezier, hover states are quick color/transform transitions (~0.15s), a connection-status dot pulses via a soft expanding box-shadow ring, faction/group strength bars animate their width on change, health/stat bars animate width/color on change. Nothing should animate continuously/idly in a way that's distracting; motion should mark something actually changing.

### What must NOT be hardcoded into the UI

Component *names* like "faction," "war," "alliance," "colony machine," "hack," "steal," "betrayal" must not appear as fixed UI categories, icons, or copy — the old build had these baked into the event-icon lookup table, the CSS class names (`.k-war`, `.k-alliance`, `.fcard .f-tech`), and copy strings, which is exactly the kind of engine-imposed social structure this rebuild is removing. The new UI's event/group/node views must be driven by whatever generic, low-level facts the engine actually tracks (an agent moved, spoke, sent a message, executed code, changed its own files, joined a self-declared group name, died) and by whatever structure agents create *in their own data* (a group name an agent chose, a status string an agent wrote about itself) — never by a fixed enum of social-relationship types the engine enforces. The visual system (colors, glass panels, layout, motion, typography above) is what should be reused; the specific mechanic-flavored labels/icons/colors keyed to old engine concepts should not.
