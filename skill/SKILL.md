---
name: astro-processing
description: Process astrophotography images end to end through the PixInsight MCP server — calibration with darks, flats and bias, subframe selection, registration, stacking, and post-processing to a finished image. Use this skill whenever the user mentions stacking, calibration frames, darks, flats, bias, subs, light frames, FITS or .fit files, an ASIAIR folder, PixInsight, WBPP, integration, a master light, or asks to process, stack, or "fix" an astro image of any deep-sky target — even if they never say "PixInsight" and even if they only ask a small question like "why is my background green", "is this frame any good", or "why do my stars look weird".
---

# Astro Processing via PixInsight

You drive PixInsight through an MCP server. PixInsight stays warm between calls, so image windows
persist and you can work iteratively.

## The rule that matters most

**Look at the image after every meaningful step.** Call `render_preview` and actually examine the
result before deciding what to do next. Processing astro data blind produces confident nonsense:
burnt star cores, clipped blacks, ringing halos, magenta stars. Numbers from `image_statistics` tell
you whether something is broken; the preview tells you whether it is *good*. Use both.

Never chain more than two destructive operations without looking.

## Workflow

### 1. Inventory before anything else

```
pi_status          → is the daemon up, which optional modules exist (BXT/NXT/SXT)
scan_frames(root)  → what data is actually there (groups: light_01, dark_03 …) + warnings
match_calibration  → which masters go with which lights, and why (grade, Δ°C, policy)
```

`scan_frames` runs in Node without PixInsight and is instant. Read its `warnings` (e.g. sensor
temperature drift during a session) and pass them on.

Report to the user: target, number of lights, exposure, gain, total integration time, and which
calibration frames were found. **Show them the calibration plan and get confirmation before
stacking.** A wrong dark match wastes an hour of compute and produces a subtly broken result that is
hard to diagnose later.

**Stop rule (house rule).** If `match_calibration` returns `needs_confirmation` (dark temperature
mismatch beyond 2 °C, dark scaling, no/aged flats, unusable flats) — or you notice anything else
that does not fit (temperature drift, wrong gain, frames from another night) — do NOT stack.
Report the exact issue with numbers, say what data would fix it (e.g. "gain-50 darks at −10 °C,
30 × 180 s"), and ask the user whether to proceed anyway or wait for better calibration frames.
`pipeline_run` enforces this: it refuses with `NEEDS_CONFIRMATION` until you pass
`acknowledge_warnings: true`, which you may only do after the user has explicitly agreed.

Flag these out loud:
- No flats → say so plainly; vignetting and dust motes will not be correctable afterwards.
- No darks → survivable on a cooled CMOS sensor, but enable cosmetic-correction auto-detect.
- Darks whose exposure or temperature does not match the lights.
- Flats from a different night or a very different focus position.

### 1b. Blink before stacking (mandatory)

`blink_frames { group_id }` renders a contact sheet of every sub (auto-stretched thumbnails with
background level, star count, gradient) and flags suspects in red. LOOK at the sheet: clouds, dew,
dawn, satellite trails, wind, focus slips. Then `exclude_frames { indexes, reason }`. Tell the
user which frames you dropped and why. With fewer than ~20 frames be reluctant; with plenty of
frames, be strict. `pipeline_run` honours the exclusion list automatically.

### 2. Calibration and stacking

**Default engine is WBPP** (PixInsight's WeightedBatchPreprocessing, what the user normally uses).
`pipeline_run { light_group_id }` runs WBPP in a separate PixInsight instance with exactly the
calibration groups chosen by `match_calibration`, then opens the master light in the daemon as view
`master_light` and deletes WBPP's intermediates. Working files live in
`<object folder>/working-files/` (next to the lights, e.g. `.../M 31/working-files`), never in the
raw data folders themselves. Only switch to `engine: "native"` when the user asks for the
step-by-step chain or wants to intervene between stages. Poll `pipeline_status` every 30-60 s and
relay the stage + progress to the user.

The native chain, for reference (order matters):

```
build_master_bias / build_master_dark / build_master_flat   (cached by content fingerprint)
calibrate_lights
cosmetic_correction   (cfa: true — the frames are still mosaiced)
debayer               (one-shot colour only)
measure_subframes → select_subframes   (weights computed from FWHM/eccentricity/SNR, stamped as SSWEIGHT)
register              (+ .xdrz drizzle data)
local_normalization
integrate             (→ master light view + rejection maps)
[drizzle_integrate]
```

Use the individual tools when the user wants to intervene (different selection limits, a
reference frame of their choosing, re-integration with another rejection algorithm). A failed
pipeline is resumable: `pipeline_run { resume_id }` after fixing the cause. For a quick sanity
check of a new night, `pipeline_run { max_frames: 4, force: true }` or `fast_integrate`.

Do not debayer before cosmetic correction — it smears hot pixels into their neighbours.

Master frames, calibration, cosmetic, debayer, measure, registration, normalization and
integration are **asynchronous**: they return a `job_id`. Use `job_wait { job_id, max_seconds: 60 }`
(blocks up to a minute) instead of hammering `job_status`; report `progress.current/total` and
`eta_seconds` to the user. A 30-frame run takes roughly 15–25 minutes on a 26 MP OSC sensor;
local normalization is the slowest stage. Only one PixInsight job runs at a time — sync tools
return `PI_BUSY` while a long job runs, so inspect things before or after, not during.

After integration, check the rejection statistics. A high rejected-pixel percentage means satellite
trails, clouds, or a bad frame that slipped through selection — investigate rather than proceeding.

### 3. Subframe selection judgement

Do not blindly accept the default expression. Look at the measurement spread first:

- Tight FWHM spread → keep almost everything; throwing away good signal is worse than a slightly
  softer stack.
- A long tail of bad frames (wind, clouds, focus drift) → cut it.
- Fewer than ~20 total frames → be very reluctant to reject any. Signal-to-noise wins.

Tell the user what you rejected and why, with numbers.

### 4. Post-processing: the default recipe (galaxy / broadband OSC)

Goals: DBE for gradients, noise removed but detail kept, HDR core, **small stars so the object
stands out**, natural colours with the blue star-forming regions brought out, then project save,
`PROCESSING.md` and a 16-bit TIFF for Photoshop. Preview after every step; check clipping with
`image_statistics` after every stretch/curve. Parameters below are the M31 defaults that worked;
scale them to the data (fewer frames → gentler denoise/contrast).

Linear stage:

1. `gradient_correction { method: "DBE" }` — check `dry_run` first: need ≥ 12 clean samples
   (raise `tolerance` / `samples_per_row` if fewer)
2. `background_neutralize`
3. `plate_solve` then `color_calibrate { method: "SPCC" }` (needs the local Gaia DR3/SP database:
   `gaia_info`; install with `configure_gaia { dir }`). Fallback only if truly unavailable:
   `color_calibrate { method: "ColorCalibration" }`
4. `denoise { method: "native", strength: 0.3 }` (NoiseXTerminator if installed). Verify with a
   1:1 `crop_preview` that dust lanes and faint stars survived — lower strength if not

Stretch and structure:

5. `stretch { method: "masked", target_background: 0.15 }` — MaskedStretch keeps star cores small
6. `hdr_compress { layers: 6, iterations: 1 }` — reveals the core/inner dust lanes
7. `range_mask { mask_id: "gal_mask", low: 0.22, fuzziness: 0.15, smoothness: 8, stretch: false }`
   → `apply_mask { id, mask_id: "gal_mask", visible: false }` →
   `local_contrast { radius: 160, slope_limit: 1.8, amount: 0.35 }` → `apply_mask { id, remove: true }`
   → `close_window { id: "gal_mask" }` (local contrast on the object only; never on sky/stars)

Colour:

8. `scnr { amount: 0.7 }`
9. `saturation { curve: [[0,0.25],[0.1,0.3],[0.3,0.25],[0.5,0.45],[0.62,0.7],[0.72,0.7],[0.85,0.35],[1,0.25]] }`
   (hue curve: blue/cyan boosted most; a second pass
   `[[0,0.05],[0.35,0.05],[0.5,0.3],[0.6,0.55],[0.7,0.55],[0.8,0.25],[1,0.05]]` if the outer arms still look grey)
10. `curves { contrast: 0.18 }` and a faint-end lift `curves { curves: { K: [[0,0],[0.08,0.105],[0.3,0.35],[0.7,0.72],[1,1]] } }`
    to pull the outer halo, then bring the sky back to ~0.12:
    `curves { curves: { K: [[0,0],[0.17,0.115],[0.5,0.47],[0.8,0.8],[1,1]] } }` (adjust the first x to the measured median)

Stars and framing:

11. `reduce_stars { amount: 0.7, iterations: 3, operator: "erosion" }` — StarMask protects the object;
    verify with `crop_preview` (no dark rings, faint stars still present). `amount 0.5, iterations 2,
    operator selection` is the gentle variant
12. `rotate { angle: 180 }` / `crop` as the user wants the framing (after SPCC; drops the solution)

Finish:

13. `save_project { id, name }` (also writes `PROCESSING.md`), `save_image { format: "tif", bit_depth: 16 }`
    and a `.jpg` into `working-files/export/`, then `cleanup_working_files { also_checkpoints: true }`.
    Report the TIFF, project and PROCESSING.md paths and send the JPEG to the user.

Do not add: native Richardson-Lucy deconvolution (rings), unmasked LHE (bloats stars, amplifies sky
noise), a plain hard STF stretch (bloats stars), sharpening without a mask.

### Quality gates — check after every stretch or sharpening step

| Check | Tool | Fail condition |
|---|---|---|
| Clipped blacks | `image_statistics` | more than ~0.02 % of pixels at zero |
| Saturated cores | `image_statistics` | a jump in saturated-pixel count |
| Ringing / dark halos around stars | `crop_preview` at 1:1 | visible dark rims |
| Star bloat or colour loss | `measure_stars` + `crop_preview` | FWHM grew, stars went white or magenta |
| Background neutrality | `image_statistics` per channel | channel medians diverging |

If a gate fails, roll back to the checkpoint the tool reported and retry with gentler parameters.
Do not try to repair an over-processed image with more processing.

## Housekeeping

- Working files: `<object>/working-files/` (previews, checkpoints, master/, project/, export/).
  Intermediates are deleted automatically as stages complete; `cleanup_working_files` for the rest.
- Never leave tens of GB behind: after the final export run `cleanup_working_files` (keeps master,
  project, export, previews, checkpoints unless told otherwise).

## Modal dialogs

PixInsight sometimes pops a modal message box (geometry changes that drop the astrometric solution,
catalog/network errors). The daemon cannot see or click it, so the job stays `running` with a
silent console. `job_status` reports `hint: "console silent for N s…"` in that case: tell the user
to click the dialog (or `pi_stop mode:'kill'` + `pi_restart`). All wrapped processes are executed
with `noGUIMessages = true`, which prevents most of them; `rotate`/`crop` after `plate_solve` are
normal and just discard the solution.

## Rollback and code changes

- Every destructive tool returns `checkpoint` (an .xisf path). `restore_checkpoint { path, id }`
  puts it back in place; `undo` steps PixInsight's history.
- `pi_restart` kills and relaunches PixInsight (needed after editing `pjsr/`); open windows are
  lost, so `save_image` first.
- `apply_process { process, id, params }` runs any installed process; `process_params { process }`
  lists exact parameter names. `pi_run_pjsr` runs raw script (helpers: `PIMCP.win.view(id)`,
  `PIMCP.preview.render`).

## Working style

- Prefer conservative parameters and more iterations over one aggressive pass.
- When a process is not wrapped as a dedicated tool, use `apply_process`, or `pi_run_pjsr` for
  anything genuinely custom.
- Save an `.xisf` checkpoint before any destructive step.
- Keep the user informed at each phase boundary — this is a long process and silence reads as a
  hang.

## Things that commonly go wrong

| Symptom | Likely cause |
|---|---|
| Strong residual vignetting | flat not applied, or flat from a different optical configuration |
| Grid or maze pattern in the background | debayer applied before cosmetic correction, or wrong Bayer pattern |
| Amplifier glow in a corner | master dark missing or mismatched |
| Walking noise (diagonal streaks) | no dither during capture — cannot be fixed in processing; tell the user to dither next session |
| Green background cast | colour calibration not run, or background neutralization skipped |
| Dark rings around bright stars | deconvolution too aggressive |
| Very high rejection percentage | satellite trails or clouds in some frames |
| Light group split in two / temperature drift warning | cooler setpoint changed mid-session (ASIAIR); darks are matched on the median temperature |
| `PI_BUSY` errors | a long job is running — `job_wait` it or `job_cancel` |
| `NOT_INSTALLED` | BXT/NXT/SXT/StarNet absent — use the native fallbacks (`deconvolve method:native`, `denoise method:native`) or skip |
