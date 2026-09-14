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

Flag these out loud:
- No flats → say so plainly; vignetting and dust motes will not be correctable afterwards.
- No darks → survivable on a cooled CMOS sensor, but enable cosmetic-correction auto-detect.
- Darks whose exposure or temperature does not match the lights.
- Flats from a different night or a very different focus position.

### 2. Calibration and stacking

Preferred: one call, `pipeline_run { light_group_id }`, then poll `pipeline_status` every 30–60 s
and relay the stage + progress to the user. It runs exactly this fixed chain (order matters):

```
build_master_bias / build_master_dark / build_master_flat   (cached by content fingerprint)
calibrate_lights
cosmetic_correction   (cfa: true — the frames are still mosaiced)
debayer               (one-shot colour only)
measure_subframes → select_subframes   (approval written as a SubframeSelector expression)
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

### 4. Post-processing

Linear stage, in this order:

1. `plate_solve` — needed by colour calibration
2. `gradient_correction` — remove light pollution gradients
3. `deconvolve` in correction mode (BlurXTerminator), if installed
4. `color_calibrate` (SPCC)
5. `denoise` (NoiseXTerminator) — while still linear
6. `remove_stars` (StarXTerminator), if you plan to stretch stars and nebula separately
7. `stretch` — the linear-to-nonlinear transition

Non-linear stage: saturation, contrast, local sharpening, star recombination, final crop.

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
