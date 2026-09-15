# pixinsight-mcp

An MCP server that gives an AI agent full control over [PixInsight](https://pixinsight.com): FITS
inventory and calibration matching, master frames, calibration → cosmetic correction → debayer →
subframe selection → registration → local normalization → integration (+ drizzle), and a wrapped
post-processing toolbox — with **JPEG previews the agent can actually look at** between steps.

Designed for a one-shot-colour rig (ZWO ASI2600MC Pro + ASIAIR) but not limited to it.

```
Claude Code ──stdio──▶ Node MCP server ──jobs/*.json──▶ PJSR daemon inside a warm PixInsight
                             ▲                                │
                       results/*.json, logs/*.log ◀───────────┘   heartbeat.json every 2 s
```

PixInsight has no network API, so a long-lived PixInsight instance runs a PJSR daemon that polls a
job directory. The filesystem is the transport. Image windows stay open between tool calls.

## Requirements

- Windows (tested: Windows 11, PixInsight **1.9.4**; the daemon uses PixInsight's `#engine v8`).
  Linux/macOS should work with the same launcher flags but are untested (Linux needs a display / Xvfb).
- Node ≥ 20.
- Optional: BlurXTerminator / NoiseXTerminator / StarXTerminator. Detected at runtime; tools fall
  back to native PixInsight processes when absent.

## Install

```bash
git clone <this repo> pixinsight-mcp
cd pixinsight-mcp
npm install
npm run build          # or use `npm run dev` (tsx) during development
```

### Configure

Create `pixinsight-mcp.config.json` next to the package (or `~/.pixinsight-mcp.json`, or set
`PIMCP_CONFIG=<path>`):

```json
{
  "piExe": "C:/Program Files/PixInsight/bin/PixInsight.exe",
  "dataRoot": "C:/Users/me/Astro/Astronomy",
  "requireFlats": true,
  "allowRawScripts": true,
  "autoLaunch": true,
  "rig": { "pixelSizeUm": 3.76, "focalLengthMm": 490, "cameraGainEPerAdu": 0.25, "bayerPattern": "RGGB" }
}
```

| Key | Meaning |
|---|---|
| `piExe` | PixInsight executable |
| `dataRoot` | Your raw data. **Never written to.** Default workdir is `<dataRoot>/../pixinsight-mcp-work` |
| `workdir` | Override where sessions, masters, previews and the bridge live |
| `requireFlats` | Refuse `calibrate_lights` / `pipeline_run` without a master flat unless `force:true` |
| `allowRawScripts` | Enable `pi_run_pjsr` (arbitrary script execution in PixInsight) |
| `autoLaunch` | Start PixInsight automatically when a tool needs it |
| `includeAdpScripts` | Compile PixInsight's ImageSolver/AnnotateImage into the daemon (`plate_solve`, `annotate`) |
| `tolerances` | `exposurePct` (0.5), `tempOkC` (2), `tempAcceptableC` (5), `flatAgeWarnDays` (14), `focusWarnSteps` (200) |
| `rig` | Pixel size / focal length (→ arcsec/px), camera gain e-/ADU for SubframeSelector |

Environment overrides: `PIMCP_PI_EXE`, `PIMCP_DATA_ROOT`, `PIMCP_WORKDIR`, `PIMCP_REQUIRE_FLATS`,
`PIMCP_ALLOW_RAW_SCRIPTS`, `PIMCP_AUTO_LAUNCH`.

### Register with Claude Code

`.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "node",
      "args": ["E:/dev-projects/pixinsight-mcp/dist/index.js"],
      "env": { "PIMCP_CONFIG": "E:/dev-projects/pixinsight-mcp/pixinsight-mcp.config.json" }
    }
  }
}
```

The agent-facing workflow guide is `skill/SKILL.md` (also served as the MCP resource `pi://skill`
and used by the `process-session` prompt). Install it as a Claude skill for best results.

## How PixInsight is driven

- `PixInsight.exe -n --automation-mode -r="<repo>/pjsr/daemon.js,<workdir>/bridge"` is spawned
  detached. The GUI is visible; you can watch windows appear.
- The daemon claims `bridge/jobs/<id>.json` by renaming it to `.claimed`, runs the op, streams the
  console to `bridge/logs/<id>.log` (`Console.beginLog`), and writes `bridge/results/<id>.json`.
- Heartbeat every 2 s. A stale heartbeat while idle, or a dead PID, is reported as `DAEMON_DEAD`
  instead of hanging. A heartbeat that is stale while `busy` is normal (blocking process call).
- One PixInsight job at a time. Long jobs are async (`job_id`); sync tools refuse with `PI_BUSY`
  while a long job runs.
- Per-frame operations (calibrate, cosmetic, debayer, register, normalize) run one frame per
  process call so progress is exact and `job_cancel` works at frame boundaries. ImageIntegration
  is a single blocking call: progress comes from the console log; it can only be aborted with
  `pi_stop mode:'kill'`.
- The PJSR code is compiled at PixInsight start. After editing anything under `pjsr/`, call
  `pi_restart`.

## House rules baked in (configurable)

| Rule | Config |
|---|---|
| Working files live next to the object: `<lights folder or its parent>/working-files/` | `workLayout: "target"`, `workingDirName` |
| Stacking engine = PixInsight **WBPP** (separate instance, exact matched calibration groups, `platesolve=false`) | `stackingEngine: "wbpp"` (`"native"` for the tool chain), `wbppParams` |
| Blink review before stacking: `blink_frames` contact sheet, then `exclude_frames` | - |
| Intermediates deleted as soon as the next stage succeeds; `cleanup_working_files` for the rest | `keepIntermediates: false` |
| Post-processing style: DBE (auto samples), denoise, MaskedStretch (small stars), colour, project save + 16-bit TIFF | see `skill/SKILL.md` |

## Tools (95)

**Session** `pi_status` `pi_capabilities` `pi_start_session` `pi_list_sessions` `pi_use_session`
`pi_end_session` `pi_console_log` `pi_run_pjsr` `pi_restart` `pi_stop`

**Jobs** `job_status` `job_wait` `job_log` `job_cancel` `list_jobs`

**Inventory (Node only, no PixInsight)** `scan_frames` `group_files` `fits_header`
`match_calibration` `list_masters`

**Calibration** `build_master_bias` `build_master_dark` `build_master_flat` `calibrate_lights`
`cosmetic_correction` `debayer`

**Stacking** `measure_subframes` `select_subframes` `register` `local_normalization` `integrate`
`drizzle_integrate` `fast_integrate`

**Inspection** `list_windows` `open_image` `close_window` `duplicate_window` `image_statistics`
`histogram` `image_keywords` `render_preview` `crop_preview` `compare_previews` `measure_stars`
`set_screen_stretch` `save_image` `checkpoint` `restore_checkpoint` `undo` `list_checkpoints`

**Post-processing** `apply_process` `process_params` `gradient_correction` `plate_solve` `annotate`
`color_calibrate` `background_neutralize` `scnr` `deconvolve` `denoise` `remove_stars` `stretch`
`curves` `saturation` `resample` `crop` `auto_crop` `pixel_math` `linear_fit` `sharpen`
`hdr_compress` `local_contrast` `combine_stars` `extract_channels` `convert_to_gray` `invert`

**Masks** `star_mask` `range_mask` `pixelmath_mask` `apply_mask` `mask_info` `binarize`
`morphology` `blur`

**Orchestration** `pipeline_run` (engine wbpp | native) `pipeline_status` `wbpp_run` `wbpp_status`

**Review / project** `blink_frames` `exclude_frames` `save_project` `cleanup_working_files`

Resources: `pi://session/current`, `pi://previews/{name}`, `pi://jobs/{id}/log`, `pi://masters`,
`pi://skill`. Prompts: `process-session`, `inspect-frame`.

## Calibration policy (CMOS)

`match_calibration` encodes the rules from the brief and returns its reasoning:

| Pair | Exact | Tolerance |
|---|---|---|
| light ↔ dark | INSTRUME, GAIN, OFFSET, binning | EXPTIME ±0.5 %; CCD-TEMP graded ok ≤ 2 °C, acceptable ≤ 5 °C, poor beyond (nearest set is still chosen, with a warning) |
| light ↔ flat | INSTRUME, binning, FILTER | warn if DATE-OBS > 14 d apart or FOCUSPOS > 200 steps |
| flat ↔ flat-dark | INSTRUME, GAIN, OFFSET, binning | EXPTIME ±0.5 % |
| any ↔ bias | INSTRUME, GAIN, OFFSET, binning | — |

Decision tree: matching darks → **dark + flat only** (no bias, no dark optimisation; the bias is
inside the dark). Exposure mismatch and `allow_dark_scaling` → bias + `optimizeDarks` + bias-
calibrated dark (flagged second-best). Flats are always calibrated with a flat-dark (preferred) or
bias, never with the light dark. No darks → bias + flat, cosmetic auto-detect mandatory.
Light groups are never split by temperature (drift is reported as a warning instead).

Masters are content-addressed (`<workdir>/masters/master_<kind>_<fingerprint>.xisf` + JSON
sidecar) and reused instantly.

## Worked example

```
pi_status                                  → daemon, modules, open windows
scan_frames { root: "C:/.../Astronomy" }   → light_01 (M 31, 30×180 s), dark_03 (180 s g100), …
match_calibration { light_group_id: "light_01" }
   → dark_03 chosen (Δ4.7 °C, acceptable), no flats (warning), policy dark-only, bias off
blink_frames { group_id: "light_01" }                  → contact sheet; #1 hazy → exclude_frames { indexes: [1] }
pipeline_run { light_group_id: "light_01" }          → WBPP in M 31/working-files/wbpp, master opened as view master_light
pipeline_status                                       → stage register 8/13, current 12/30 …
render_preview { id: "<master_view_id>" }             → look at it
measure_stars / image_statistics                      → FWHM, eccentricity, noise, clipping
gradient_correction { method: "DBE" } → background_neutralize → color_calibrate → denoise → stretch { method: "masked" }
→ scnr → saturation → save_project → save_image { format: "tif", bit_depth: 16 }
```

Every destructive tool writes an `.xisf` checkpoint first and returns its path; `restore_checkpoint`
rolls back.

## Development

```bash
npm test                              # unit tests (no PixInsight): headers, matching, policy, …
npm run fixtures                      # synthetic 128×96 RGGB fixtures under tests/fixtures/data
npx tsx scripts/smoke.ts              # list tools
npx tsx scripts/smoke.ts pi_status '{"launch":true}'
npx tsx scripts/pipeline-smoke.ts '{"light_group_id":"light_01","max_frames":4,"force":true}'
PI_INTEGRATION=1 npm run test:integration   # end-to-end on fixtures (needs PixInsight)
```

`pjsr/reference/*.txt` holds the default `toSource()` of every wrapped process as dumped from
PixInsight 1.9.4 — the source of truth for parameter names. Regenerate with
`pjsr/reference/dump-process-params.js` after a PixInsight update.

### PJSR gotchas learned the hard way

- `#engine v8` is required for modern syntax and to include PixInsight's ImageSolver library.
  Under V8, process enums are statics (`ImageIntegration.Average`), 64-bit counters are `BigInt`,
  `View.viewById` returns `null` (not a null-object), `Histogram` is `new Histogram(bins)` +
  `generate(image)`.
- The PJSR preprocessor treats `/*` inside a `//` comment as a block-comment start.
- Scripts that use `let`/`class` in `#include`d files need `#engine v8` in the *including* file.
- `SubframeSelector.measurements` is read-only from scripts and weighting expressions evaluate to
  0 when driven from a script, so subframe weights are computed in Node (`computeWeights`) and
  written into the frames as `SSWEIGHT` by the `write_weights` op.
- ImageSolver 6.x: `solver.initialize(window, false)` then `solver.solveImage(window)` (throws).
  Plate solving and SPCC need the Gaia DR3/SP catalog: either the local database files
  (PixInsight → Resources → Gaia DR3) or a working TLS connection to VizieR.

## Safety

Outputs are refused under `dataRoot` or any scanned root; nothing is overwritten (masters are
content-addressed, `save_image` needs `overwrite:true`); inspection works on clones; fewer than 3
frames are refused without `force`; destructive tools checkpoint first; one PixInsight job at a time.

## Non-goals (v1)

Mosaics, comet stacking, multi-filter LRGB logic, a web UI. Seams exist (`FrameGroup.filter`,
`apply_process`, `pi_run_pjsr`).
