# Build Prompt: `pixinsight-mcp`

> Paste this whole document to a coding agent (Claude Code or equivalent) as the project brief.
> Work through it phase by phase. Do not skip to later phases before the acceptance criteria of
> the current one pass on real data.

---

## 1. Mission

Build an MCP server that gives an AI agent full control over PixInsight — from raw sub-exposures
through calibration, stacking and post-processing, to a finished image. The agent must be able to
**see** what it produced at every step and correct itself, not process blind.

**Target rig** (design for this first, generalize later):

| Component | Value |
|---|---|
| Camera | ZWO ASI2600MC Pro — **one-shot color (OSC)**, APS-C, 16-bit, cooled |
| Telescope | ZWO FF70 APO refractor |
| Mount | ZWO AM5N (harmonic) |
| Controller | ASIAIR Plus — writes `.fit` files in its own directory layout |
| Filters | None / single light-pollution or dual-band filter in the train |

Because the sensor is OSC there is **no filter wheel, no LRGB channel combination, and no per-filter
master set**. The pipeline is a single linear chain. Do not build multi-filter abstractions in v1;
leave a seam for them.

**Stack:** TypeScript + `@modelcontextprotocol/sdk` for the server, PJSR (PixInsight JavaScript
Runtime, ECMAScript 5) for everything that runs inside PixInsight.

---

## 2. Why the architecture looks like this

PixInsight exposes no network API. It has three interfaces: GUI, a console/command line, and PJSR.
Launching the application per command costs 15–20 seconds of startup and throws away all open image
windows, which makes an iterative agent loop unusable.

So: **one long-lived PixInsight instance running a PJSR daemon that polls a job directory.**

```
AI agent  ──MCP──▶  Node server  ──writes job JSON──▶  jobs/
                         ▲                              │
                         │                              ▼
                    results/  ◀──writes result──  PJSR daemon loop
                                                    (inside PixInsight)
```

The filesystem is the transport. It is boring, debuggable, survives a PixInsight crash, and needs no
sockets inside PJSR.

**Consequences to honour throughout:**

- Image windows stay open between tool calls. State is real. Tools address images by view id.
- Long operations (integration, registration) must be **asynchronous** — an MCP call cannot block
  for 40 minutes.
- Anything that can be answered without waking PixInsight (FITS header inventory, file matching,
  master library lookups) should be done in Node. Keep PixInsight for pixel work.

---

## 3. Repository layout

```
pixinsight-mcp/
├── src/
│   ├── index.ts              # MCP server entry, tool registration
│   ├── config.ts             # paths, PI executable, flags
│   ├── bridge/
│   │   ├── client.ts         # write job, await result, poll heartbeat
│   │   ├── jobs.ts           # job id, atomic write, timeouts
│   │   └── launcher.ts       # start/stop PixInsight + daemon, Xvfb on Linux
│   ├── fits/
│   │   ├── header.ts         # raw FITS header parser (no PI needed)
│   │   └── types.ts
│   ├── matching/
│   │   ├── inventory.ts      # scan tree → frame records
│   │   ├── match.ts          # light↔dark↔flat↔bias matching rules
│   │   └── masters.ts        # content-addressed master library
│   ├── tools/                # one file per tool group
│   └── util/fingerprint.ts   # SHA-256 caching keys
├── pjsr/
│   ├── daemon.js             # the polling loop
│   ├── lib/                  # shared helpers (json, log, window registry)
│   └── ops/                  # one file per operation
│       ├── calibration.js
│       ├── registration.js
│       ├── integration.js
│       ├── inspect.js
│       └── postprocess.js
├── skill/
│   └── SKILL.md              # agent-facing usage skill (provided separately)
├── tests/
│   └── fixtures/             # 5 lights, 5 darks, 5 flats, 5 bias — tiny crops
└── README.md
```

---

## 4. The bridge protocol

### Directory structure (per session)

```
<workdir>/sessions/<session_id>/
├── jobs/       <job_id>.json      # request, written atomically (.tmp then rename)
├── results/    <job_id>.json      # response
├── logs/       <job_id>.log       # streamed PixInsight console output
├── previews/   <view>_<hash>.jpg  # rendered previews
├── work/                          # all intermediate images
└── heartbeat.json                 # daemon writes every 2s
```

### Request

```json
{
  "id": "job_01HX...",
  "op": "integrate",
  "args": { "...": "..." },
  "timeout_ms": 3600000,
  "created_at": "2026-09-14T20:11:00Z"
}
```

### Result

```json
{
  "id": "job_01HX...",
  "status": "ok | error | running",
  "progress": { "step": "integrating", "current": 42, "total": 120, "message": "..." },
  "data": { "...": "..." },
  "error": { "code": "PI_PROCESS_FAILED", "message": "...", "console_tail": "..." },
  "started_at": "...",
  "finished_at": "..."
}
```

### Daemon rules

- Poll `jobs/` every 250 ms. Claim a job by renaming it to `<job_id>.claimed`.
- Write a `running` result immediately, update `progress` as the operation reports.
- Wrap every operation in try/catch. **Never let an exception kill the loop** — write an `error`
  result and continue polling.
- Write `heartbeat.json` with a timestamp and PixInsight version every 2 s. The Node side treats a
  heartbeat older than 15 s as a dead daemon and surfaces that as a tool error rather than hanging.
- Honour a `stop` op for clean shutdown.

### Node side

- `startJob(op, args)` → job id, returns immediately.
- `awaitJob(id, { timeout })` → polls `results/`, used for fast operations.
- Every tool that may exceed ~20 s exposes the async form. See §7.

---

## 5. FITS inventory and calibration matching (Node, no PixInsight)

### Header parsing

FITS headers are 2880-byte blocks of 80-character ASCII cards ending at `END`. Parse them directly —
do not shell out to PixInsight to learn what a file is. Read only the first few blocks per file.

Keys to extract:

`IMAGETYP`, `EXPTIME`/`EXPOSURE`, `GAIN`, `OFFSET`/`BLKLEVEL`, `CCD-TEMP`, `SET-TEMP`,
`XBINNING`/`YBINNING`, `INSTRUME`, `FILTER`, `BAYERPAT`, `DATE-OBS`, `OBJECT`, `FOCALLEN`,
`XPIXSZ`, `NAXIS1`, `NAXIS2`, `FOCUSPOS`.

### Frame classification

Trust `IMAGETYP` first; fall back to the ASIAIR path convention
(`Autorun/Light|Dark|Flat|Bias/<target>/...`) and then to filename heuristics. Report the method used
so the agent can flag ambiguity to the user.

### Matching rules

These are the correctness core of the whole project. Encode them explicitly, with tolerances, and
return the reasoning so the agent can explain it.

| Pair | Must match exactly | Tolerance |
|---|---|---|
| light ↔ dark | `INSTRUME`, `GAIN`, `OFFSET`, binning | `EXPTIME` ±0.5 %, `CCD-TEMP` ±2 °C |
| light ↔ flat | `INSTRUME`, binning, `FILTER` | same optical train; warn if `DATE-OBS` differs by > 14 days or `FOCUSPOS` by > 200 steps |
| flat ↔ flat-dark | `INSTRUME`, `GAIN`, `OFFSET`, binning | `EXPTIME` ±0.5 % |
| any ↔ bias | `INSTRUME`, `GAIN`, `OFFSET`, binning | — |

### CMOS calibration policy — get this right

The classical CCD recipe is wrong for a modern cooled CMOS sensor. Implement this decision tree and
expose its output as part of `match_calibration`:

1. **Darks match the lights' exposure, gain, offset and temperature** (the normal ASIAIR case):
   calibrate lights with **master dark + master flat only**. `masterBiasEnabled = false`,
   `optimizeDarks = false`, `calibrateDark = false`. The bias signal is already inside the dark.
   Subtracting bias as well double-counts it.
2. **Darks do not match exposure** and the user wants dark scaling: enable bias, enable
   `optimizeDarks`, and calibrate the master dark with the master bias. Warn the agent that this is
   second-best for CMOS.
3. **Flats** are always calibrated with either a **master flat-dark** (preferred, same exposure as
   the flats) or a **master bias** (acceptable). Never with the light master dark.
4. **No darks at all**: allow flat + bias only, and warn about hot pixels — `CosmeticCorrection`
   auto-detect becomes mandatory.

The ASI2600MC Pro has negligible amp glow, so a missing master dark is survivable. A missing master
flat is not — refuse to proceed without one unless the caller passes `force: true`.

### Master library

Masters are cached by a fingerprint of `{camera, gain, offset, binning, exptime, temp_bucket, frame
count, sorted file hashes}`. Store at `<workdir>/masters/<fingerprint>.xisf` with a sidecar JSON of
the source frames and integration parameters. `build_master_*` returns the cached path instantly on
a hit unless `force: true`.

---

## 6. Tool catalogue

Expose a **layered** surface. Resist the urge to publish one tool per PixInsight process — the agent
drowns. Roughly 30 tools, grouped.

### 6.1 Session & system

| Tool | Args | Returns |
|---|---|---|
| `pi_status` | — | daemon alive, PI version, installed modules (BXT/NXT/SXT present?), open windows, current session |
| `pi_start_session` | `name?`, `workdir?` | session id, paths |
| `pi_end_session` | `close_windows?` | — |
| `pi_console_log` | `lines` | tail of the PixInsight console |
| `pi_run_pjsr` | `script`, `timeout_ms` | stdout, returned JSON |

`pi_run_pjsr` is the escape hatch that saves the project when a process is unwrapped. Gate it behind
a config flag `allowRawScripts` (default **on** for a personal rig, document the risk).

### 6.2 Inventory & planning

| Tool | Args | Returns |
|---|---|---|
| `scan_frames` | `root`, `recursive?` | frame records grouped by type/target/exposure/gain/temp, with counts and total integration time |
| `match_calibration` | `light_group_id` | chosen masters or source frames, the rule applied, warnings, calibration policy per §5 |
| `list_masters` | `filter?` | master library contents |

### 6.3 Calibration

| Tool | Args |
|---|---|
| `build_master_bias` | `files[]`, `out?`, `force?` |
| `build_master_dark` | `files[]`, `master_bias?`, `out?`, `force?` |
| `build_master_flat` | `files[]`, `master_bias?`, `master_flat_dark?`, `out?`, `force?` |
| `calibrate_lights` | `files[]`, `master_dark?`, `master_flat?`, `master_bias?`, `optimize_darks?` |
| `cosmetic_correction` | `files[]`, `master_dark?`, `cfa: true`, `auto_sigma?` |
| `debayer` | `files[]`, `pattern: auto\|RGGB\|...`, `method?` |

**Order matters and is not negotiable for OSC:**
`calibrate → cosmetic correction (CFA-aware, still mosaiced) → debayer`.
Debayering before cosmetic correction smears hot pixels across neighbours.

### 6.4 Registration & integration

| Tool | Args |
|---|---|
| `measure_subframes` | `files[]`, `pixel_scale?`, `gain?` → per-frame FWHM, eccentricity, SNR, star count, median |
| `select_subframes` | `measurements`, `expression?` or `{max_fwhm, max_ecc, min_stars}` → approved/rejected with reasons |
| `register` | `files[]`, `reference?` (default: best weighted frame), `generate_drizzle?` |
| `local_normalization` | `files[]`, `reference`, `scale?` |
| `integrate` | `files[]`, `rejection?`, `normalization?`, `weights?`, `lnorm_files?` |
| `drizzle_integrate` | `xdrz[]`, `scale: 1\|2`, `drop_shrink?` — optional, phase 6 |

Defaults that should be the tool's built-in behaviour:

- Rejection algorithm chosen by frame count: < 8 → Percentile Clipping, 8–20 → Winsorized Sigma,
  > 20 → Linear Fit Clipping. Expose the choice in the result.
- Normalization: additive with scaling; rejection normalization: scale + zero offset.
- Weights: the `SSWEIGHT` FITS keyword written by `measure_subframes`.
- Always generate rejection maps and report the rejected-pixel percentage — a high number is the
  single best early warning that something is wrong.

### 6.5 Inspection — the most important group

Without these the agent is guessing.

| Tool | Returns |
|---|---|
| `list_windows` | open view ids, dimensions, colour space, linear/non-linear flag |
| `image_statistics` | per channel: median, MAD, σ, min/max, clipped-black count, saturated count, noise estimate |
| `render_preview` | **base64 JPEG**, downsampled to ≤ 1024 px long edge, `stretch: stf\|none\|hard` |
| `crop_preview` | base64 JPEG of a 1:1 region — for star shapes, halos, ringing |
| `measure_stars` | count, median FWHM, eccentricity, PSF fit — objective quality numbers |

`render_preview` returning an image the model can actually look at is the feature that makes this
project worth building. Implement it in phase 2, before any post-processing tool.

### 6.6 Post-processing

| Tool | Notes |
|---|---|
| `apply_process` | `process_name`, `params` (JSON), `target` — generic fallback for any installed process |
| `gradient_correction` | GradientCorrection / DBE / ABE depending on what is installed |
| `plate_solve` | ImageSolver — required before SPCC |
| `color_calibrate` | SPCC preferred, PCC fallback; needs an astrometric solution |
| `deconvolve` | BlurXTerminator if installed — `correct_only` mode for the linear stage |
| `denoise` | NoiseXTerminator |
| `remove_stars` | StarXTerminator → starless + star mask |
| `stretch` | `method: sts \| histogram \| arcsinh \| masked`, with target background parameter |
| `save_image` | `target`, `path`, `format: xisf\|tif\|png\|jpg`, `bit_depth` |

### 6.7 Jobs

| Tool | Args |
|---|---|
| `job_status` | `job_id` → status, progress, elapsed, ETA |
| `job_log` | `job_id`, `tail` |
| `job_cancel` | `job_id` |
| `list_jobs` | `session?`, `active_only?` |

---

## 7. Async policy

| Operation | Mode |
|---|---|
| status, statistics, list, preview, crop | synchronous, < 5 s |
| cosmetic correction, debayer, measure, master bias | synchronous with 120 s timeout |
| master dark, master flat, calibrate lights | async |
| register, local normalization, integrate, drizzle | **always async** |
| BXT / NXT / SXT on a full-size frame | async |

Async tools return `{ job_id, estimated_seconds }` immediately. The agent is expected to poll
`job_status`. Document this in the Skill so the agent does not sit and wait.

Parse progress out of the PixInsight console (`ImageIntegration` prints per-frame lines) and expose
it as `current/total`. Nothing else makes a 45-minute integration tolerable.

---

## 8. PJSR implementation notes

PJSR is **ECMAScript 5**. No `let`, no arrow functions, no template literals, no `Promise`, no
`async`. Write the daemon accordingly, or transpile — but hand-written ES5 is simpler here.

Useful primitives: `File`, `File.readTextFile`, `File.writeTextFile`, `ImageWindow`,
`ImageWindow.open`, `View`, `Console.writeln`, `processEvents()`, `msleep(n)`, `JSON` is available.

Skeleton:

```javascript
// pjsr/daemon.js  — ES5 only
#include "lib/json.js"
#include "ops/calibration.js"

function mainLoop(sessionDir) {
   var jobsDir = sessionDir + "/jobs";
   for (;;) {
      var pending = searchDirectory(jobsDir + "/*.json");
      for (var i = 0; i < pending.length; ++i) {
         var claimed = pending[i].replace(".json", ".claimed");
         try { File.move(pending[i], claimed); } catch (e) { continue; }
         runJob(claimed, sessionDir);
      }
      writeHeartbeat(sessionDir);
      processEvents();      // keeps the UI responsive and the app alive
      msleep(250);
   }
}
```

**Getting parameter names right:** the samples below are a starting point, not gospel. For every
process, run it once manually in the GUI, drag the triangle in the bottom-left of the process window
to the workspace to create a process icon, then right-click the icon → *Edit Instance Source Code*.
That gives the exact, version-correct parameter list. Verify each wrapper this way before shipping
it. Do not guess parameter names from memory.

### Master bias

```javascript
var II = new ImageIntegration;
II.images = files.map(function (f) { return [true, f, "", ""]; });
II.combination            = ImageIntegration.prototype.Average;
II.rejection              = ImageIntegration.prototype.WinsorizedSigmaClip;
II.normalization          = ImageIntegration.prototype.NoNormalization;
II.rejectionNormalization = ImageIntegration.prototype.NoRejectionNormalization;
II.weightMode             = ImageIntegration.prototype.DontCare;
II.generateRejectionMaps  = true;
II.executeGlobal();
```

Master dark: identical, but calibrate the darks with the master bias first **only** if dark
optimization will be used. Master flat: `normalization = MultiplicativeWithScaling`,
`rejectionNormalization = EqualizeFluxes`.

### Light calibration (CMOS default path)

```javascript
var IC = new ImageCalibration;
IC.targetFrames      = files.map(function (f) { return [true, f]; });
IC.masterBiasEnabled = false;                 // see §5 policy
IC.masterDarkEnabled = true;
IC.masterDarkPath    = masterDark;
IC.masterFlatEnabled = true;
IC.masterFlatPath    = masterFlat;
IC.optimizeDarks     = false;
IC.calibrateDark     = false;
IC.outputDirectory   = outDir;
IC.outputExtension   = ".xisf";
IC.outputPostfix     = "_c";
IC.executeGlobal();
```

### Cosmetic correction — CFA aware, before debayer

```javascript
var CC = new CosmeticCorrection;
CC.targetFrames  = files.map(function (f) { return [true, f]; });
CC.useMasterDark = true;
CC.masterPath    = masterDark;
CC.hotDarkCheck  = true;
CC.coldDarkCheck = false;
CC.useAutoDetect = true;
CC.hotAutoValue  = 3.0;
CC.cfa           = true;        // critical for OSC
CC.executeGlobal();
```

### Debayer

```javascript
var D = new Debayer;
D.cfaPattern    = Debayer.prototype.Auto;   // reads BAYERPAT; RGGB on ASI2600MC
D.debayerMethod = Debayer.prototype.VNG;
D.evaluateNoise = true;
```

### Subframe selection

```javascript
var SS = new SubframeSelector;
SS.routine             = SubframeSelector.prototype.MeasureSubframes;
SS.subframes           = files.map(function (f) { return [true, f, ""]; });
SS.subframeScale       = pixelScaleArcsecPerPixel;
SS.cameraGain          = eMinusPerADU;
SS.approvalExpression  = "FWHM <= FWHMMedian*1.25 && Eccentricity <= 0.60";
SS.weightingExpression =
   "10*(1-(FWHM-FWHMMin)/(FWHMMax-FWHMMin)) + " +
   "10*(1-(Eccentricity-EccentricityMin)/(EccentricityMax-EccentricityMin)) + " +
   "20*(SNRWeight-SNRWeightMin)/(SNRWeightMax-SNRWeightMin) + 50";
```

Then re-run with `routine = OutputSubframes` to write `SSWEIGHT` into the headers.

### Registration, normalization, integration

```javascript
var SA = new StarAlignment;
SA.referenceImage      = referencePath;
SA.targets             = files.map(function (f) { return [true, true, f]; });
SA.outputDirectory     = regDir;
SA.generateDrizzleData = true;

var LN = new LocalNormalization;
LN.referencePathOrViewId = referencePath;
LN.targetItems           = regFiles.map(function (f) { return [true, f]; });
LN.scale                 = 256;

var II = new ImageIntegration;
II.images = regFiles.map(function (f) { return [true, f, "", lnormFor(f)]; });
II.normalization          = ImageIntegration.prototype.LocalNormalization;
II.rejectionNormalization = ImageIntegration.prototype.Scale;
II.weightMode             = ImageIntegration.prototype.KeywordWeight;
II.weightKeyword          = "SSWEIGHT";
II.rejection              = pickRejection(regFiles.length);
```

### Preview rendering

Clone the view, apply an STF as a HistogramTransformation to the clone (never to the working image),
resample to ≤ 1024 px, save as JPEG quality 85, base64-encode, delete the clone. Return the path
too, so the user can open it themselves.

---

## 9. Safety rules

Non-negotiable, enforce in code and not merely in documentation:

1. **Never write into the source directories.** All output goes under
   `<workdir>/sessions/<id>/work/` or `<workdir>/masters/`. Refuse any output path under a scanned
   input root.
2. **Never delete or overwrite user files.** Masters are content-addressed; collisions produce a new
   fingerprint, never an overwrite.
3. **Never modify a view in place** during inspection. Previews and statistics operate on clones.
4. Refuse to integrate fewer than 3 frames without `force: true`.
5. Every destructive post-processing tool writes an `.xisf` checkpoint before running, and reports
   the checkpoint path so the agent can roll back.
6. Cap concurrent jobs at 1. PixInsight is not reentrant across image windows the way you want.

---

## 10. Build phases

Each phase ends with a demo on **real data from the rig**, not synthetic frames.

### Phase 1 — Bridge
`pi_status`, `pi_start_session`, `pi_run_pjsr`, job protocol, daemon, heartbeat, launcher
(with Xvfb on Linux — PixInsight is not truly headless and needs a display).

*Acceptance:* from an MCP client, run an arbitrary PJSR snippet that opens a FITS file and returns
its dimensions, three times in a row, on one warm PixInsight instance, in under 2 seconds each after
the first.

### Phase 2 — Eyes
`list_windows`, `image_statistics`, `render_preview`, `crop_preview`, `measure_stars`.

*Acceptance:* the agent opens a single unstretched light frame, renders an STF preview, and
correctly describes what is in it. This is the go/no-go for the whole project.

### Phase 3 — Inventory
FITS header parser, `scan_frames`, `match_calibration`, master library.

*Acceptance:* point it at an untouched ASIAIR `Autorun` folder; it returns the correct target, frame
counts, total integration time, and a calibration plan whose reasoning a human agrees with —
including correctly deciding *not* to use bias when darks match.

### Phase 4 — Stacking
All of §6.3 and §6.4, async jobs, progress reporting, caching.

*Acceptance:* one tool-call sequence takes raw lights + darks + flats + bias to a registered,
integrated master light. Compare it to the same data run through WBPP in the GUI: the median,
noise estimate and star FWHM should match within a few percent. If they do not, the pipeline is
wrong — debug before continuing.

### Phase 5 — Post-processing
`apply_process` plus the wrappers in §6.6, checkpoints, rollback.

*Acceptance:* a full linear-to-nonlinear chain on the phase-4 master, with the agent inspecting a
preview between every step.

### Phase 6 — Refinement
Drizzle integration (needs dithered subs and `.xdrz` from registration), mosaics, multi-session
integration, a second camera profile to prove the rig assumptions are properly abstracted.

---

## 11. Testing

- **Unit:** FITS header parsing, matching rules with tolerance edge cases, rejection-algorithm
  selection, fingerprinting. No PixInsight required — these are where the real bugs live.
- **Integration:** check in ~20 tiny cropped frames (a few hundred pixels square) of each type as
  fixtures. A full pipeline run on them should finish in under two minutes, which makes it usable as
  a pre-commit check.
- **Golden master:** store the statistics of a known-good integration and assert the pipeline
  reproduces them within tolerance. This catches silent regressions when PixInsight updates change a
  default.
- **Chaos:** kill PixInsight mid-job and confirm the server reports a dead daemon instead of hanging
  forever.

---

## 12. Non-goals for v1

Do not build: mosaic composition, multi-night normalization across different optical trains, a web
UI, comet stacking, spectroscopy, mono/LRGB filter logic, or a plugin marketplace. Leave clean
seams; build none of it now.

---

## 13. Deliverables

1. Working MCP server with all tools in §6.
2. PJSR daemon and operation modules.
3. `skill/SKILL.md` — the agent-facing usage skill.
4. `README.md` with installation, the PixInsight path configuration, Xvfb setup for Linux, and a
   worked end-to-end example.
5. Fixture data and the test suite from §11.
