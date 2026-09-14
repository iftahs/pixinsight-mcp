// pjsr/ops/postprocess.js — generic process application and wrapped post-processing steps. ES5.
// Every destructive op takes an optional checkpoint_dir; when given, an .xisf checkpoint is written first.

PIMCP.pp = {
   /** Run fn on view with optional checkpoint; returns { checkpoint, ...fn() }. */
   destructive: function (args, fn) {
      var v = PIMCP.win.view(PIMCP.req(args, "id"));
      var ck = null;
      if (args.checkpoint_dir && args.checkpoint !== false) ck = PIMCP.checkpoint(v, args.checkpoint_dir, args.checkpoint_label || args._op || "ckpt");
      var before = PIMCP.pp.quickStats(v);
      var r = fn(v) || {};
      r.id = v.id;
      r.checkpoint = ck;
      r.before = before;
      r.after = PIMCP.pp.quickStats(v);
      return r;
   },
   quickStats: function (v) {
      var img = v.image, n = img.numberOfChannels, med = [], clip = [];
      for (var c = 0; c < n; ++c) {
         img.selectedChannel = c;
         med.push(PIMCP.round(img.median(), 7));
         var h = new Histogram(4096); h.generate(img);
         clip.push(PIMCP.round(100 * h.count(0) / (img.width * img.height), 4));
      }
      img.resetSelections();
      return { median: med, clipped_low_pct: clip, size: [img.width, img.height] };
   },
   exec: function (P, v, swap) {
      var ok = P.executeOn(v, swap !== false);
      if (!ok) PIMCP.fail("PI_PROCESS_FAILED", P.processId + " failed on " + v.id);
      return ok;
   },
   requireProcess: function (name) {
      if (!PIMCP.hasProcess(name)) PIMCP.fail("NOT_INSTALLED", name + " is not installed in this PixInsight");
      return eval(name);
   },
   /** Enum by name with fallbacks, returning first that exists. */
   enumOr: function (ctor, names) {
      for (var i = 0; i < names.length; ++i) { if (typeof ctor[names[i]] !== "undefined") return ctor[names[i]]; if (typeof ctor.prototype[names[i]] !== "undefined") return ctor.prototype[names[i]]; }
      PIMCP.fail("BAD_ENUM", "none of " + names.join("/") + " exist on " + ctor.prototype.processId);
   }
};

/** Generic: apply any installed process by name with a flat parameter object. */
PIMCP.ops.apply_process = function (args) {
   var name = PIMCP.req(args, "process");
   var ctor = PIMCP.pp.requireProcess(name);
   var P = new ctor;
   var params = args.params || {};
   PIMCP.assignParams(P, params, { ignoreUnknown: !!args.ignore_unknown });
   if (args.id) {
      args._op = name;
      return PIMCP.pp.destructive(args, function (v) { PIMCP.pp.exec(P, v, args.swap_file !== false); return { process: name, source: P.toSource() }; });
   }
   if (!P.executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", name + " executeGlobal failed");
   return { process: name, executed: "global", source: P.toSource() };
};

/** Return the default parameter listing of a process (for agents exploring apply_process). */
PIMCP.ops.process_params = function (args) {
   var name = PIMCP.req(args, "process");
   var ctor = PIMCP.pp.requireProcess(name);
   var P = new ctor;
   return { process: name, source: P.toSource() };
};

// ------------------------------------------------------------------ gradient
PIMCP.ops.gradient_correction = function (args) {
   args._op = "gradient";
   return PIMCP.pp.destructive(args, function (v) {
      var method = args.method || (PIMCP.hasProcess("GradientCorrection") ? "GradientCorrection" : "ABE");
      if (method === "GradientCorrection") {
         var P = new GradientCorrection;
         if (args.scale !== undefined) P.scale = Number(args.scale);
         if (args.smoothness !== undefined) P.smoothness = Number(args.smoothness);
         if (args.iterations !== undefined) P.iterations = Number(args.iterations);
         P.protection = args.protection !== false;
         if (args.params) PIMCP.assignParams(P, args.params);
         PIMCP.pp.exec(P, v);
         return { method: method };
      }
      if (method === "ABE") {
         var A = new AutomaticBackgroundExtractor;
         A.polyDegree = Number(args.degree || 4);
         A.targetCorrection = PIMCP.pp.enumOr(AutomaticBackgroundExtractor, [args.correction === "divide" ? "Correction_Divide" : "Correction_Subtract", "Subtract"]);
         A.replaceTarget = true;
         A.discardModel = true;
         A.normalize = args.normalize !== false;
         if (args.params) PIMCP.assignParams(A, args.params);
         PIMCP.pp.exec(A, v);
         return { method: method, degree: A.polyDegree };
      }
      if (method === "DBE") {
         var D = new DynamicBackgroundExtraction;
         // Automatic sample grid via samplesPerRow; DBE needs explicit samples — use its auto generation via executeOn with no samples is not supported.
         PIMCP.fail("NOT_SUPPORTED", "DBE requires manually placed samples; use method 'GradientCorrection' or 'ABE', or apply_process with explicit DynamicBackgroundExtraction samples");
      }
      PIMCP.fail("BAD_ARGS", "unknown gradient method " + method);
   });
};

// ------------------------------------------------------------------ plate solving (ImageSolver library, compiled in via generated/adp.js)
PIMCP.ops.plate_solve = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var w = v.window;
   if (typeof ImageSolver === "undefined") PIMCP.fail("NOT_INSTALLED", "ImageSolver library not compiled into the daemon (generated/adp.js missing or includeAdpScripts=false)");
   if (w.hasAstrometricSolution && !args.force) return { id: v.id, solved: true, cached: true, summary: w.astrometricSolutionSummary() };
   var solver = new ImageSolver();
   var cfg = solver.solverCfg;
   cfg.useActive = true; cfg.files = [];
   cfg.showStars = false; cfg.showDistortion = false; cfg.generateErrorImg = false; cfg.showStarMatches = false;
   cfg.distortionCorrection = args.distortion_correction !== false;
   cfg.autoMagnitude = true;
   if (args.magnitude !== undefined) { cfg.autoMagnitude = false; cfg.magnitude = Number(args.magnitude); }
   if (args.catalog) cfg.catalog = String(args.catalog);
   // ImageSolver 6.x (PixInsight 1.9): initialize(window, forceDefaults=false) extracts RA/DEC/FOCALLEN/XPIXSZ from the
   // image metadata; explicit args override afterwards. solveImage() returns void and throws on failure.
   var md = solver.metadata;
   md.referenceSystem = "ICRS"; md.topocentric = false; md.useFocal = true;
   if (args.focal_length) md.focal = Number(args.focal_length);
   if (args.pixel_size) md.xpixsz = Number(args.pixel_size);
   if (md.focal && md.xpixsz) md.resolution = md.xpixsz / md.focal * 0.18 / Math.PI;
   var initOk = false;
   try { solver.initialize(w, false); initOk = true; } catch (e) { PIMCP.warn("ImageSolver.initialize: " + e); }
   md = solver.metadata;
   if (args.ra !== undefined) md.ra = Number(args.ra);
   if (args.dec !== undefined) md.dec = Number(args.dec);
   if (args.focal_length) { md.focal = Number(args.focal_length); md.useFocal = true; }
   if (args.pixel_size) md.xpixsz = Number(args.pixel_size);
   if (md.focal && md.xpixsz && !(md.resolution > 0)) md.resolution = md.xpixsz / md.focal * 0.18 / Math.PI;
   if (md.ra === undefined || md.dec === undefined || md.ra === null || md.dec === null || isNaN(md.ra) || isNaN(md.dec)) PIMCP.fail("SOLVE_NEEDS_SEED", "no RA/DEC in headers; pass ra and dec (degrees), plus focal_length (mm) and pixel_size (um)");
   PIMCP.progress("plate_solve", 0, 1, "ImageSolver (seed RA " + PIMCP.round(md.ra, 4) + " DEC " + PIMCP.round(md.dec, 4) + ", " + PIMCP.round(md.resolution * 3600, 3) + " arcsec/px)");
   try { solver.solveImage(w); } catch (e2) { PIMCP.fail("SOLVE_FAILED", String(e2)); }
   if (!w.hasAstrometricSolution) PIMCP.fail("SOLVE_FAILED", "ImageSolver finished without a solution; check ra/dec seed, focal length, pixel size and network access to the Gaia catalog");
   var m = solver.metadata;
   return { id: v.id, solved: true, cached: false, init_from_headers: initOk, ra: PIMCP.round(m.ra, 6), dec: PIMCP.round(m.dec, 6),
            resolution_arcsec_px: PIMCP.round(m.resolution * 3600, 5), focal_mm: m.focal ? PIMCP.round(m.focal, 2) : null,
            summary: w.astrometricSolutionSummary() };
};

/** Annotate a plate-solved image (AnnotationEngine) and return a preview JPEG. */
PIMCP.ops.annotate = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var w = v.window;
   if (!w.hasAstrometricSolution) PIMCP.fail("NO_ASTROMETRY", "annotate needs a plate solution; run plate_solve first");
   if (typeof AnnotationEngine === "undefined") PIMCP.fail("NOT_INSTALLED", "AnnotationEngine not compiled into the daemon (generated/adp.js)");
   var before = {};
   var ws = ImageWindow.windows;
   for (var i = 0; i < ws.length; ++i) before[ws[i].mainView.id] = true;
   var engine = new AnnotationEngine;
   engine.Init(w);
   engine.outputMode = AnnotationEngine.OutputMode.Image;
   engine.applySTF = v.image.median() < 0.08;
   engine.writeObjects = false;
   var want = args.layers || ["Messier", "NGC", "Named Stars", "Constellation Lines", "Grid"];
   var rx = new RegExp(want.join("|").replace(/\s+/g, "\s*"), "i");
   var visible = [];
   for (i = 0; i < engine.layers.length; ++i) {
      var L = engine.layers[i];
      L.visible = rx.test(String(L.layerName));
      if (L.visible) visible.push(String(L.layerName));
   }
   PIMCP.progress("annotate", 0, 1, "rendering " + visible.join(", "));
   engine.Render();
   var out = null;
   ws = ImageWindow.windows;
   for (i = 0; i < ws.length; ++i) if (!before[ws[i].mainView.id]) out = ws[i];
   if (!out) PIMCP.fail("ANNOTATE_FAILED", "AnnotationEngine produced no output window");
   try {
      var r = PIMCP.preview.render(out.mainView, { out_path: PIMCP.req(args, "out_path"), max_edge: args.max_edge || 1600, stretch: "none" });
      r.id = v.id; r.layers = visible;
      return r;
   } finally { if (!args.keep_window) out.forceClose(); else r.annotated_id = out.mainView.id; }
};

// ------------------------------------------------------------------ colour
PIMCP.ops.background_neutralize = function (args) {
   args._op = "bn";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new BackgroundNeutralization;
      P.backgroundReferenceViewId = args.reference_id || "";
      if (args.background_high !== undefined) P.backgroundHigh = Number(args.background_high);
      if (args.params) PIMCP.assignParams(P, args.params);
      PIMCP.pp.exec(P, v);
      return { method: "BackgroundNeutralization" };
   });
};

PIMCP.ops.color_calibrate = function (args) {
   args._op = "colorcal";
   var method0 = args.method || "SPCC";
   if ((method0 === "SPCC" || method0 === "PCC") && !PIMCP.win.view(PIMCP.req(args, "id")).window.hasAstrometricSolution)
      PIMCP.fail("NO_ASTROMETRY", "SPCC/PCC need a plate solution; run plate_solve first");
   return PIMCP.pp.destructive(args, function (v) {
      var method = args.method || "SPCC";
      var w = v.window;
      if (method === "SPCC" || method === "PCC") {
         var P;
         if (method === "SPCC") {
            P = new (PIMCP.pp.requireProcess("SpectrophotometricColorCalibration"));
            P.narrowbandMode = !!args.narrowband;
            // Defaults in 1.9.4 already target a Sony colour sensor with UV/IR cut; the ASI2600MC matches.
            if (args.white_reference) P.whiteReferenceName = args.white_reference;
         } else {
            P = new (PIMCP.pp.requireProcess("PhotometricColorCalibration"));
         }
         P.applyCalibration = true;
         P.neutralizeBackground = args.neutralize_background !== false;
         P.backgroundReferenceViewId = args.background_reference_id || "";
         P.generateGraphs = false;
         P.generateStarMaps = false;
         if (args.limit_magnitude !== undefined) { P.autoLimitMagnitude = false; P.limitMagnitude = Number(args.limit_magnitude); }
         if (args.params) PIMCP.assignParams(P, args.params);
         PIMCP.pp.exec(P, v);
         return { method: method };
      }
      if (method === "ColorCalibration") {
         var C = new ColorCalibration;
         C.structureDetection = true;
         if (args.white_reference_id) C.whiteReferenceViewId = args.white_reference_id;
         if (args.background_reference_id) C.backgroundReferenceViewId = args.background_reference_id;
         if (args.params) PIMCP.assignParams(C, args.params);
         PIMCP.pp.exec(C, v);
         return { method: method };
      }
      PIMCP.fail("BAD_ARGS", "unknown color calibration method " + method);
   });
};

PIMCP.ops.scnr = function (args) {
   args._op = "scnr";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new SCNR;
      P.amount = Number(args.amount === undefined ? 1.0 : args.amount);
      P.colorToRemove = PIMCP.enumOf(SCNR, args.color || "Green", "color");
      P.protectionMethod = PIMCP.enumOf(SCNR, args.protection || "AverageNeutral", "protection");
      P.preserveLightness = args.preserve_lightness !== false;
      PIMCP.pp.exec(P, v);
      return { amount: P.amount };
   });
};

// ------------------------------------------------------------------ deconvolution / noise / stars (RC-Astro with fallbacks)
PIMCP.ops.deconvolve = function (args) {
   args._op = "decon";
   return PIMCP.pp.destructive(args, function (v) {
      if (PIMCP.hasProcess("BlurXTerminator") && args.method !== "native") {
         var B = new BlurXTerminator;
         if (args.correct_only !== undefined && "correct_only" in B) B.correct_only = !!args.correct_only;
         if (args.sharpen_stars !== undefined && "sharpen_stars" in B) B.sharpen_stars = Number(args.sharpen_stars);
         if (args.sharpen_nonstellar !== undefined && "sharpen_nonstellar" in B) B.sharpen_nonstellar = Number(args.sharpen_nonstellar);
         if (args.adjust_halos !== undefined && "adjust_halos" in B) B.adjust_halos = Number(args.adjust_halos);
         if (args.params) PIMCP.assignParams(B, args.params);
         PIMCP.pp.exec(B, v);
         return { method: "BlurXTerminator" };
      }
      if (args.method && args.method !== "native") PIMCP.fail("NOT_INSTALLED", "BlurXTerminator not installed; use method:'native' for PixInsight Deconvolution");
      // Native RL deconvolution with a parametric PSF sized from measured FWHM.
      var fwhm = Number(args.fwhm_px || 0);
      if (!fwhm) {
         try { var st = PIMCP.stars.detect(v.image, {}); var fits = PIMCP.stars.fitPSF(v, st, 60); var fw = []; for (var i = 0; i < fits.length; ++i) fw.push(fits[i].fwhm); fwhm = PIMCP.stars.median(fw) || 3; } catch (e) { fwhm = 3; }
      }
      var P = new Deconvolution;
      P.algorithm = PIMCP.enumOf(Deconvolution, "RichardsonLucy");
      P.numberOfIterations = Number(args.iterations || 20);
      P.psfMode = PIMCP.enumOf(Deconvolution, "Parametric");
      P.psfSigma = fwhm / 2.3548;
      P.psfShape = 2.0;
      P.toLuminance = true;
      P.deringing = true;
      P.deringingDark = Number(args.deringing_dark === undefined ? 0.02 : args.deringing_dark);
      P.deringingBright = 0;
      P.useRegularization = true;
      P.waveletLayers = [[3.0, 1.0], [2.0, 0.7]];
      P.numberOfWaveletLayers = 2;
      if (args.params) PIMCP.assignParams(P, args.params);
      PIMCP.pp.exec(P, v);
      return { method: "Deconvolution(RL)", fwhm_px: PIMCP.round(fwhm, 3), iterations: P.numberOfIterations };
   });
};

PIMCP.ops.denoise = function (args) {
   args._op = "denoise";
   return PIMCP.pp.destructive(args, function (v) {
      if (PIMCP.hasProcess("NoiseXTerminator") && args.method !== "native") {
         var N = new NoiseXTerminator;
         if (args.denoise !== undefined && "denoise" in N) N.denoise = Number(args.denoise);
         if (args.detail !== undefined && "detail" in N) N.detail = Number(args.detail);
         if (args.params) PIMCP.assignParams(N, args.params);
         PIMCP.pp.exec(N, v);
         return { method: "NoiseXTerminator" };
      }
      if (args.method && args.method !== "native") PIMCP.fail("NOT_INSTALLED", "NoiseXTerminator not installed; use method:'native'");
      var strength = Number(args.strength === undefined ? 0.5 : args.strength); // 0..1
      if (args.method === "TGV" || (args.method === undefined && v.image.median() > 0.08)) {
         var T = new TGVDenoise;
         T.rgbkMode = false;
         T.strengthL = 3 + 7 * strength; T.strengthC = 4 + 8 * strength;
         T.edgeProtectionL = 0.002; T.edgeProtectionC = 0.003;
         T.maxIterationsL = 100; T.maxIterationsC = 100;
         if (args.params) PIMCP.assignParams(T, args.params);
         PIMCP.pp.exec(T, v);
         return { method: "TGVDenoise", strength: strength };
      }
      // Linear data: MultiscaleLinearTransform noise reduction on first layers with a linear mask.
      var M = new MultiscaleLinearTransform;
      var s1 = 2 + 3 * strength, s2 = 1.5 + 2 * strength, s3 = 1 + 1.5 * strength;
      // enabled, biasEnabled, bias, noiseReductionEnabled, noiseReductionThreshold, noiseReductionAmount, noiseReductionIterations, linearMask...
      M.layers = [
         [true, true, 0.000, true, s1, 0.90, 3],
         [true, true, 0.000, true, s2, 0.80, 2],
         [true, true, 0.000, true, s3, 0.60, 1],
         [true, true, 0.000, false, 3.000, 1.00, 1],
         [true, true, 0.000, false, 3.000, 1.00, 1]
      ];
      M.linearMask = true; M.linearMaskAmpFactor = 100; M.linearMaskSmoothness = 1.0; M.linearMaskInverted = true;
      M.linear = true;
      if (args.params) PIMCP.assignParams(M, args.params);
      PIMCP.pp.exec(M, v);
      return { method: "MultiscaleLinearTransform", strength: strength };
   });
};

PIMCP.ops.remove_stars = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var starsId = null;
   if (PIMCP.hasProcess("StarXTerminator")) {
      args._op = "starx";
      return PIMCP.pp.destructive(args, function (view) {
         var S = new StarXTerminator;
         if ("stars" in S) S.stars = args.stars_image !== false;
         if ("unscreen" in S) S.unscreen = !!args.unscreen;
         if ("linear" in S) S.linear = !!args.linear;
         if (args.params) PIMCP.assignParams(S, args.params);
         PIMCP.pp.exec(S, view);
         // SXT names the stars image "<id>_stars"
         var sw = ImageWindow.windowById(view.id + "_stars");
         starsId = (sw && !PIMCP.isNull(sw)) ? sw.mainView.id : null;
         return { method: "StarXTerminator", stars_id: starsId };
      });
   }
   if (PIMCP.hasProcess("StarNet2") || PIMCP.hasProcess("StarNet")) {
      args._op = "starnet";
      return PIMCP.pp.destructive(args, function (view) {
         var ctor = PIMCP.hasProcess("StarNet2") ? StarNet2 : StarNet;
         var S = new ctor;
         if ("mask" in S) S.mask = args.stars_image !== false;
         if ("stride" in S) S.stride = 0;
         if (args.params) PIMCP.assignParams(S, args.params);
         PIMCP.pp.exec(S, view);
         var ws = ImageWindow.windows, sid = null;
         for (var i = 0; i < ws.length; ++i) if (/star_mask|_stars/i.test(ws[i].mainView.id)) sid = ws[i].mainView.id;
         return { method: ctor.prototype.processId, stars_id: sid };
      });
   }
   PIMCP.fail("NOT_INSTALLED", "no star removal tool installed (StarXTerminator / StarNet2). Install one or use star_mask + masked processing instead.");
};

// ------------------------------------------------------------------ stretch
PIMCP.ops.stretch = function (args) {
   args._op = "stretch";
   return PIMCP.pp.destructive(args, function (v) {
      var method = args.method || "sts";
      if (method === "sts" || method === "histogram") {
         // Screen-transfer stretch: AutoSTF with a target background, made permanent via HT.
         var mode = args.hard ? "hard" : "stf";
         var stf = PIMCP.stf.compute(v, mode, args.linked !== false);
         if (args.target_background !== undefined || args.shadows_clip !== undefined) {
            var tb = Number(args.target_background === undefined ? 0.25 : args.target_background);
            var sc = Number(args.shadows_clip === undefined ? -2.8 : args.shadows_clip);
            var saved = [PIMCP.stf.SHADOWS_CLIP, PIMCP.stf.TARGET_BKG];
            PIMCP.stf.SHADOWS_CLIP = sc; PIMCP.stf.TARGET_BKG = tb;
            try { stf = PIMCP.stf.compute(v, "stf", args.linked !== false); } finally { PIMCP.stf.SHADOWS_CLIP = saved[0]; PIMCP.stf.TARGET_BKG = saved[1]; }
         }
         PIMCP.stf.applyAsHT(v, stf);
         return { method: "AutoSTF->HistogramTransformation", stf: stf.channels, linked: stf.linked };
      }
      if (method === "arcsinh") {
         var A = new ArcsinhStretch;
         A.stretch = Number(args.stretch || 50);
         A.blackPoint = Number(args.black_point === undefined ? Math.max(0, v.image.median() - 2.8 * v.image.MAD() * 1.4826) : args.black_point);
         A.protectHighlights = args.protect_highlights !== false;
         if (args.params) PIMCP.assignParams(A, args.params);
         PIMCP.pp.exec(A, v);
         return { method: "ArcsinhStretch", stretch: A.stretch, black_point: A.blackPoint };
      }
      if (method === "masked") {
         var M = new MaskedStretch;
         M.targetBackground = Number(args.target_background === undefined ? 0.125 : args.target_background);
         M.numberOfIterations = Number(args.iterations || 100);
         M.clippingFraction = Number(args.clipping_fraction === undefined ? 0.0005 : args.clipping_fraction);
         if (args.params) PIMCP.assignParams(M, args.params);
         PIMCP.pp.exec(M, v);
         return { method: "MaskedStretch", target_background: M.targetBackground };
      }
      if (method === "mas" || method === "adaptive") {
         var S = new (PIMCP.pp.requireProcess("MultiscaleAdaptiveStretch"));
         if (args.aggressiveness !== undefined) S.aggressiveness = Number(args.aggressiveness);
         if (args.target_background !== undefined) S.targetBackground = Number(args.target_background);
         if (args.params) PIMCP.assignParams(S, args.params);
         PIMCP.pp.exec(S, v);
         return { method: "MultiscaleAdaptiveStretch", aggressiveness: S.aggressiveness, target_background: S.targetBackground };
      }
      if (method === "ghs") {
         var G = new (PIMCP.pp.requireProcess("GeneralizedHyperbolicStretch"));
         if (args.params) PIMCP.assignParams(G, args.params);
         PIMCP.pp.exec(G, v);
         return { method: "GeneralizedHyperbolicStretch" };
      }
      if (method === "ht") {
         var H = new HistogramTransformation;
         var c0 = Number(args.shadows || 0), m = Number(args.midtones || 0.5), c1 = Number(args.highlights || 1);
         H.H = [[0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [c0, m, c1, 0, 1], [0, 0.5, 1, 0, 1]];
         PIMCP.pp.exec(H, v);
         return { method: "HistogramTransformation", shadows: c0, midtones: m, highlights: c1 };
      }
      PIMCP.fail("BAD_ARGS", "unknown stretch method " + method);
   });
};

// ------------------------------------------------------------------ non-linear helpers
PIMCP.ops.curves = function (args) {
   args._op = "curves";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new CurvesTransformation;
      var applied = {};
      var map = { K: "K", RGB: "K", R: "R", G: "G", B: "B", L: "L", S: "S", a: "a", b: "b", c: "c", H: "H" };
      var curves = args.curves || {};
      for (var key in curves) {
         if (!curves.hasOwnProperty(key)) continue;
         var prop = map[key];
         if (!prop) PIMCP.fail("BAD_ARGS", "unknown curve channel " + key);
         var pts = curves[key];
         if (!PIMCP.isArray(pts) || pts.length < 2) PIMCP.fail("BAD_ARGS", "curve " + key + " needs >= 2 [x,y] points");
         P[prop] = pts;
         P[prop + "t"] = PIMCP.enumOf(CurvesTransformation, "AkimaSubsplines");
         applied[key] = pts;
      }
      // Convenience: contrast (S-curve strength) and brightness (midpoint shift) on RGB/K.
      if (args.contrast !== undefined || args.brightness !== undefined) {
         var c = Number(args.contrast || 0), b = Number(args.brightness || 0);
         var x1 = 0.25, y1 = 0.25 - 0.15 * c + b * 0.1, x2 = 0.75, y2 = 0.75 + 0.15 * c + b * 0.1;
         P.K = [[0, 0], [x1, Math.min(1, Math.max(0, y1))], [x2, Math.min(1, Math.max(0, y2))], [1, 1]];
         applied.K = P.K;
      }
      PIMCP.pp.exec(P, v);
      return { curves: applied };
   });
};

PIMCP.ops.saturation = function (args) {
   args._op = "saturation";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new ColorSaturation;
      var amt = Number(args.amount === undefined ? 0.3 : args.amount); // -1..+1 uniform boost
      P.HS = [[0, amt], [0.5, amt], [1, amt]];
      if (args.curve) P.HS = args.curve;
      PIMCP.pp.exec(P, v);
      return { amount: amt };
   });
};

PIMCP.ops.resample = function (args) {
   args._op = "resample";
   return PIMCP.pp.destructive(args, function (v) {
      if (args.factor && Number(args.factor) < 1 && Math.abs(1 / Number(args.factor) - Math.round(1 / Number(args.factor))) < 1e-6) {
         var I = new IntegerResample;
         I.zoomFactor = -Math.round(1 / Number(args.factor));
         I.downsamplingMode = PIMCP.enumOf(IntegerResample, "Average");
         PIMCP.pp.exec(I, v);
         return { method: "IntegerResample", zoom: I.zoomFactor };
      }
      var P = new Resample;
      if (args.width && args.height) { P.mode = PIMCP.enumOf(Resample, "AbsolutePixels"); P.xSize = Number(args.width); P.ySize = Number(args.height); P.absoluteMode = PIMCP.enumOf(Resample, "ForceWidthAndHeight"); }
      else { P.mode = PIMCP.enumOf(Resample, "RelativeDimensions"); P.xSize = Number(args.factor || 0.5); P.ySize = P.xSize; }
      P.interpolation = PIMCP.enumOf(Resample, args.interpolation || "Auto", "interpolation");
      PIMCP.pp.exec(P, v);
      return { method: "Resample", size: [v.image.width, v.image.height] };
   });
};

PIMCP.ops.crop = function (args) {
   args._op = "crop";
   return PIMCP.pp.destructive(args, function (v) {
      var r = PIMCP.req(args, "rect"); // [x, y, w, h]
      var img = v.image;
      var P = new Crop;
      P.mode = PIMCP.enumOf(Crop, "AbsolutePixels");
      P.leftMargin = -Number(r[0]);
      P.topMargin = -Number(r[1]);
      P.rightMargin = -(img.width - Number(r[0]) - Number(r[2]));
      P.bottomMargin = -(img.height - Number(r[1]) - Number(r[3]));
      PIMCP.pp.exec(P, v);
      return { rect: r, size: [v.image.width, v.image.height] };
   });
};

/**
 * Auto-crop registration edges: find the largest centred rectangle where the image (or the
 * supplied rejection/weight map) is non-zero in every row/column beyond a coverage threshold.
 */
PIMCP.ops.auto_crop = function (args) {
   args._op = "autocrop";
   return PIMCP.pp.destructive(args, function (v) {
      var img = v.image;
      var W = img.width, H = img.height;
      var thr = Number(args.threshold === undefined ? 0.0 : args.threshold);
      var pad = Number(args.pad || 4);
      // Sample rows/cols using a coarse grid for speed.
      var step = Math.max(1, Math.floor(Math.min(W, H) / 512));
      img.selectedChannel = 0;
      function colZeroFrac(x) { var z = 0, n = 0; for (var y = 0; y < H; y += step) { n++; if (img.sample(x, y, 0) <= thr) z++; } return z / n; }
      function rowZeroFrac(y) { var z = 0, n = 0; for (var x = 0; x < W; x += step) { n++; if (img.sample(x, y, 0) <= thr) z++; } return z / n; }
      var lim = Number(args.max_zero_fraction === undefined ? 0.02 : args.max_zero_fraction);
      var x0 = 0; while (x0 < W / 4 && colZeroFrac(x0) > lim) x0 += step;
      var x1 = W - 1; while (x1 > 3 * W / 4 && colZeroFrac(x1) > lim) x1 -= step;
      var y0 = 0; while (y0 < H / 4 && rowZeroFrac(y0) > lim) y0 += step;
      var y1 = H - 1; while (y1 > 3 * H / 4 && rowZeroFrac(y1) > lim) y1 -= step;
      img.resetSelections();
      x0 = Math.min(W - 1, x0 + pad); y0 = Math.min(H - 1, y0 + pad); x1 = Math.max(x0 + 1, x1 - pad); y1 = Math.max(y0 + 1, y1 - pad);
      var rect = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
      if (rect[2] < W * 0.5 || rect[3] < H * 0.5) PIMCP.fail("AUTOCROP_SUSPICIOUS", "auto-crop would remove more than half the image; pass rect explicitly to crop");
      var P = new Crop;
      P.mode = PIMCP.enumOf(Crop, "AbsolutePixels");
      P.leftMargin = -x0; P.topMargin = -y0; P.rightMargin = -(W - x1 - 1); P.bottomMargin = -(H - y1 - 1);
      if (!args.dry_run) PIMCP.pp.exec(P, v);
      return { rect: rect, removed: { left: x0, top: y0, right: W - x1 - 1, bottom: H - y1 - 1 }, dry_run: !!args.dry_run };
   });
};

PIMCP.ops.pixel_math = function (args) {
   args._op = "pixelmath";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new PixelMath;
      P.expression = PIMCP.req(args, "expression");
      if (args.expression_g !== undefined) { P.useSingleExpression = false; P.expression1 = args.expression_g; P.expression2 = args.expression_b || args.expression_g; }
      else P.useSingleExpression = true;
      P.rescale = !!args.rescale;
      P.truncate = args.truncate !== false;
      P.createNewImage = !!args.new_id;
      if (args.new_id) { P.newImageId = PIMCP.win.safeId(args.new_id); P.showNewImage = true; }
      if (args.params) PIMCP.assignParams(P, args.params);
      PIMCP.pp.exec(P, v);
      return { expression: P.expression, new_id: args.new_id ? P.newImageId : null };
   });
};

PIMCP.ops.linear_fit = function (args) {
   args._op = "linearfit";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new LinearFit;
      P.referenceViewId = PIMCP.req(args, "reference_id");
      PIMCP.pp.exec(P, v);
      return { reference: P.referenceViewId };
   });
};

PIMCP.ops.unsharp_mask = function (args) {
   args._op = "unsharp";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new UnsharpMask;
      P.sigma = Number(args.sigma || 2); P.amount = Number(args.amount || 0.6); P.useLuminance = true;
      P.deringing = true; P.deringingDark = Number(args.deringing_dark === undefined ? 0.1 : args.deringing_dark);
      PIMCP.pp.exec(P, v);
      return { sigma: P.sigma, amount: P.amount };
   });
};

PIMCP.ops.hdr = function (args) {
   args._op = "hdr";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new HDRMultiscaleTransform;
      P.numberOfLayers = Number(args.layers || 6); P.numberOfIterations = Number(args.iterations || 1);
      P.toLightness = true; P.preserveHue = true; P.lightnessMask = true;
      if (args.params) PIMCP.assignParams(P, args.params);
      PIMCP.pp.exec(P, v);
      return { layers: P.numberOfLayers };
   });
};

PIMCP.ops.lhe = function (args) {
   args._op = "lhe";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new LocalHistogramEqualization;
      P.radius = Number(args.radius || 64); P.slopeLimit = Number(args.slope_limit || 2); P.amount = Number(args.amount || 0.5);
      PIMCP.pp.exec(P, v);
      return { radius: P.radius, amount: P.amount };
   });
};

PIMCP.ops.invert = function (args) { args._op = "invert"; return PIMCP.pp.destructive(args, function (v) { PIMCP.pp.exec(new Invert, v); return {}; }); };

PIMCP.ops.convert_to_gray = function (args) { args._op = "gray"; return PIMCP.pp.destructive(args, function (v) { PIMCP.pp.exec(new ConvertToGrayscale, v); return {}; }); };

PIMCP.ops.extract_channels = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var P = new ChannelExtraction;
   var cs = args.color_space || "RGB";
   P.colorSpace = PIMCP.enumOf(ChannelExtraction, cs, "color space");
   var base = args.prefix || v.id;
   var ids = args.channels || (cs === "RGB" ? ["R", "G", "B"] : [cs.charAt(0), "", ""]);
   P.channels = [[!!ids[0], ids[0] ? PIMCP.win.uniqueId(base + "_" + ids[0]) : ""], [!!ids[1], ids[1] ? PIMCP.win.uniqueId(base + "_" + ids[1]) : ""], [!!ids[2], ids[2] ? PIMCP.win.uniqueId(base + "_" + ids[2]) : ""]];
   PIMCP.pp.exec(P, v, false);
   var out = [];
   for (var i = 0; i < 3; ++i) if (P.channels[i][0]) out.push(P.channels[i][1]);
   return { id: v.id, channels: out };
};

// Combine a starless image and a stars image (screen blend).
PIMCP.ops.combine_stars = function (args) {
   var starless = PIMCP.win.view(PIMCP.req(args, "starless_id"));
   var stars = PIMCP.win.view(PIMCP.req(args, "stars_id"));
   var P = new PixelMath;
   var boost = Number(args.star_boost || 1.0);
   P.expression = "~((~$T)*(~(" + stars.id + "*" + boost + ")))";
   P.useSingleExpression = true; P.rescale = false; P.truncate = true;
   P.createNewImage = !!args.new_id;
   if (args.new_id) { P.newImageId = PIMCP.win.safeId(args.new_id); P.showNewImage = true; }
   PIMCP.pp.exec(P, starless);
   return { id: args.new_id ? P.newImageId : starless.id, expression: P.expression };
};

