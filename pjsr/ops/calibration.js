// pjsr/ops/calibration.js — master frames, light calibration, cosmetic correction, debayer. ES5.
// Parameter names verified against PixInsight 1.9.4 (pjsr/reference/ dumps).

PIMCP.cal = {
   /** Pick a rejection algorithm by frame count (brief §6.4). */
   pickRejection: function (n, override) {
      if (override && override !== "auto") return { name: override, value: PIMCP.enumOf(ImageIntegration, override, "rejection") };
      var name = n < 8 ? "PercentileClip" : (n <= 20 ? "WinsorizedSigmaClip" : "LinearFit");
      return { name: name, value: PIMCP.enumOf(ImageIntegration, name, "rejection") };
   },

   /** Read integration output statistics from a finished ImageIntegration instance. */
   integrationStats: function (P, n) {
      var N = PIMCP.num;
      var px = N(P.totalPixels) || 0;
      var rl = (N(P.totalRejectedLowRK) || 0) + (N(P.totalRejectedLowG) || 0) + (N(P.totalRejectedLowB) || 0);
      var rh = (N(P.totalRejectedHighRK) || 0) + (N(P.totalRejectedHighG) || 0) + (N(P.totalRejectedHighB) || 0);
      var denom = px * (N(P.numberOfChannels) || 1);
      return {
         number_of_images: N(P.numberOfImages) || n,
         total_pixels: px,
         rejected_low: rl, rejected_high: rh,
         rejected_low_pct: denom ? PIMCP.round(100 * rl / denom, 4) : null,
         rejected_high_pct: denom ? PIMCP.round(100 * rh / denom, 4) : null,
         rejected_total_pct: denom ? PIMCP.round(100 * (rl + rh) / denom, 4) : null,
         final_noise: [P.finalNoiseEstimateRK, P.finalNoiseEstimateG, P.finalNoiseEstimateB],
         final_location: [P.finalLocationEstimateRK, P.finalLocationEstimateG, P.finalLocationEstimateB],
         reference_snr_increment: [P.referenceSNRIncrementRK, P.referenceSNRIncrementG, P.referenceSNRIncrementB],
         median_noise_reduction: [P.medianNoiseReductionRK, P.medianNoiseReductionG, P.medianNoiseReductionB],
         psf_count: [P.finalPSFCountRK, P.finalPSFCountG, P.finalPSFCountB],
         integration_image_id: P.integrationImageId,
         low_rejection_map_id: P.lowRejectionMapImageId, high_rejection_map_id: P.highRejectionMapImageId
      };
   },

   /** Save the integration window to a path, close rejection maps, return path. */
   finishIntegration: function (P, outPath, keepOpen, keepMaps) {
      var w = ImageWindow.windowById(P.integrationImageId);
      if (!w || PIMCP.isNull(w)) PIMCP.fail("INTEGRATION_NO_OUTPUT", "ImageIntegration produced no image window");
      PIMCP.fs.ensureDir(PIMCP.fs.dir(outPath));
      if (File.exists(outPath)) File.remove(outPath);
      if (!w.saveAs(outPath, false, false, false, false)) PIMCP.fail("SAVE_FAILED", "could not save " + outPath);
      var maps = {};
      var ids = [P.lowRejectionMapImageId, P.highRejectionMapImageId, P.slopeMapImageId];
      var names = ["low", "high", "slope"];
      for (var i = 0; i < ids.length; ++i) {
         if (!ids[i]) continue;
         var mw = ImageWindow.windowById(ids[i]);
         if (!mw || PIMCP.isNull(mw)) continue;
         if (keepMaps) {
            var mp = outPath.replace(/\.xisf$/i, "") + "_rej_" + names[i] + ".xisf";
            if (File.exists(mp)) File.remove(mp);
            mw.saveAs(mp, false, false, false, false);
            maps[names[i]] = mp;
         }
         mw.forceClose();
      }
      var id = w.mainView.id;
      if (!keepOpen) w.forceClose();
      return { path: outPath, view_id: keepOpen ? id : null, rejection_maps: maps };
   },

   /** Common ImageIntegration setup for master calibration frames. */
   masterIntegration: function (files, kind, opts) {
      PIMCP.assertFiles(files, kind + " frames");
      var P = new ImageIntegration;
      P.images = PIMCP.rows(files, function (f) { return [true, f, "", ""]; });
      P.combination = PIMCP.enumOf(ImageIntegration, "Average");
      P.weightMode = PIMCP.enumOf(ImageIntegration, "DontCare");
      P.evaluateSNR = false;
      P.generateRejectionMaps = true;
      P.generateIntegratedImage = true;
      P.generateDrizzleData = false;
      P.showImages = true;
      P.noGUIMessages = true;
      P.useCache = true;
      P.rangeClipLow = false;
      P.rangeClipHigh = false;
      var rej = PIMCP.cal.pickRejection(files.length, opts.rejection);
      P.rejection = rej.value;
      if (kind === "flat") {
         P.normalization = PIMCP.enumOf(ImageIntegration, "MultiplicativeWithScaling");
         P.rejectionNormalization = PIMCP.enumOf(ImageIntegration, "EqualizeFluxes");
         P.largeScaleClipHigh = true;    // dust motes/gradients protection
      } else {
         P.normalization = PIMCP.enumOf(ImageIntegration, "NoNormalization");
         P.rejectionNormalization = PIMCP.enumOf(ImageIntegration, "NoRejectionNormalization");
      }
      if (opts.params) PIMCP.assignParams(P, opts.params);
      PIMCP.progress("integrate_" + kind, 0, files.length, "starting ImageIntegration (" + rej.name + ")");
      if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "ImageIntegration failed for master " + kind);
      var stats = PIMCP.cal.integrationStats(P, files.length);
      var fin = PIMCP.cal.finishIntegration(P, opts.out, false, !!opts.keep_rejection_maps);
      return { path: fin.path, rejection: rej.name, stats: stats, frames: files.length, rejection_maps: fin.rejection_maps };
   }
};

PIMCP.ops.build_master_bias = function (args) {
   return PIMCP.cal.masterIntegration(PIMCP.req(args, "files"), "bias", { out: PIMCP.req(args, "out"), rejection: args.rejection, params: args.params, keep_rejection_maps: args.keep_rejection_maps });
};

/** Master dark. If master_bias given, darks are bias-subtracted first (only for the dark-scaling path). */
PIMCP.ops.build_master_dark = function (args) {
   var files = PIMCP.req(args, "files");
   var out = PIMCP.req(args, "out");
   var src = files;
   var tmpDir = null;
   if (args.master_bias) {
      tmpDir = PIMCP.fs.dir(out) + "/_darks_biased";
      src = PIMCP.cal.calibrateFrames(files, { master_bias: args.master_bias, out_dir: tmpDir, postfix: "_b", step: "bias_subtract_darks", cfa: true });
   }
   var r = PIMCP.cal.masterIntegration(src, "dark", { out: out, rejection: args.rejection, params: args.params, keep_rejection_maps: args.keep_rejection_maps });
   r.bias_calibrated = !!args.master_bias;
   return r;
};

/** Master flat: calibrate flats with flat-dark (preferred) or bias, then integrate multiplicatively. */
PIMCP.ops.build_master_flat = function (args) {
   var files = PIMCP.req(args, "files");
   var out = PIMCP.req(args, "out");
   var src = files, how = "none";
   if (args.master_flat_dark || args.master_bias) {
      var tmpDir = PIMCP.fs.dir(out) + "/_flats_calibrated";
      var copts = { out_dir: tmpDir, postfix: "_c", step: "calibrate_flats", cfa: true, optimize_darks: false };
      if (args.master_flat_dark) { copts.master_dark = args.master_flat_dark; how = "flat_dark"; }
      else { copts.master_bias = args.master_bias; how = "bias"; }
      src = PIMCP.cal.calibrateFrames(files, copts);
   }
   var r = PIMCP.cal.masterIntegration(src, "flat", { out: out, rejection: args.rejection, params: args.params, keep_rejection_maps: args.keep_rejection_maps });
   r.flat_calibration = how;
   return r;
};

/**
 * Calibrate frames one at a time (exact progress, cancellable). Returns output paths.
 * opts: master_bias, master_dark, master_flat, optimize_darks, calibrate_dark, out_dir, postfix, cfa, params
 */
PIMCP.cal.calibrateFrames = function (files, opts) {
   PIMCP.assertFiles(files, "target frames");
   PIMCP.fs.ensureDir(opts.out_dir);
   var outs = [], perFrame = [];
   var step = opts.step || "calibrate";
   for (var i = 0; i < files.length; ++i) {
      PIMCP.checkCancel();
      PIMCP.progress(step, i, files.length, PIMCP.fs.basename(files[i]));
      var P = new ImageCalibration;
      P.targetFrames = [[true, files[i]]];
      P.enableCFA = opts.cfa !== false;
      P.cfaPattern = PIMCP.enumOf(ImageCalibration, "Auto");
      P.masterBiasEnabled = !!opts.master_bias;
      P.masterBiasPath = opts.master_bias || "";
      P.masterDarkEnabled = !!opts.master_dark;
      P.masterDarkPath = opts.master_dark || "";
      P.masterFlatEnabled = !!opts.master_flat;
      P.masterFlatPath = opts.master_flat || "";
      P.calibrateBias = false;
      P.calibrateDark = !!opts.calibrate_dark;
      P.calibrateFlat = false;
      P.optimizeDarks = !!opts.optimize_darks;
      P.evaluateNoise = opts.evaluate_noise !== false;
      P.evaluateSignal = opts.evaluate_signal !== false;
      P.outputDirectory = opts.out_dir;
      P.outputExtension = ".xisf";
      P.outputPrefix = "";
      P.outputPostfix = opts.postfix || "_c";
      P.outputSampleFormat = PIMCP.enumOf(ImageCalibration, "f32");
      P.outputPedestalMode = PIMCP.enumOf(ImageCalibration, "OutputPedestal_Auto") !== undefined && opts.auto_pedestal ? PIMCP.enumOf(ImageCalibration, "OutputPedestal_Auto") : PIMCP.enumOf(ImageCalibration, "OutputPedestal_Literal");
      P.outputPedestal = Number(opts.output_pedestal || 0);
      P.overwriteExistingFiles = true;
      P.noGUIMessages = true;
      P.masterGUIWarnings = false;
      if (opts.params) PIMCP.assignParams(P, opts.params);
      if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "ImageCalibration failed on " + files[i]);
      var od = P.outputData;
      var row = (od && od.length) ? od[0] : null;
      var outPath = row ? row[0] : (opts.out_dir + "/" + PIMCP.fs.basename(files[i]) + (opts.postfix || "_c") + ".xisf");
      outs.push(outPath);
      perFrame.push({ input: files[i], output: outPath, dark_scale: row ? [row[1], row[2], row[3]] : null, noise: row ? [row[25], row[26], row[27]] : null });
   }
   PIMCP.progress(step, files.length, files.length, "done");
   PIMCP.cal.lastPerFrame = perFrame;
   return outs;
};

PIMCP.ops.calibrate_lights = function (args) {
   var files = PIMCP.req(args, "files");
   var outDir = PIMCP.req(args, "out_dir");
   var outs = PIMCP.cal.calibrateFrames(files, {
      master_bias: args.master_bias || null, master_dark: args.master_dark || null, master_flat: args.master_flat || null,
      optimize_darks: !!args.optimize_darks, calibrate_dark: !!args.calibrate_dark, out_dir: outDir, postfix: args.postfix || "_c",
      cfa: args.cfa !== false, params: args.params, output_pedestal: args.output_pedestal, auto_pedestal: args.auto_pedestal, step: "calibrate"
   });
   return { outputs: outs, per_frame: PIMCP.cal.lastPerFrame, masters: { bias: args.master_bias || null, dark: args.master_dark || null, flat: args.master_flat || null }, optimize_darks: !!args.optimize_darks };
};

PIMCP.ops.cosmetic_correction = function (args) {
   var files = PIMCP.req(args, "files");
   var outDir = PIMCP.req(args, "out_dir");
   PIMCP.assertFiles(files, "frames");
   PIMCP.fs.ensureDir(outDir);
   var outs = [];
   var postfix = args.postfix || "_cc";
   for (var i = 0; i < files.length; ++i) {
      PIMCP.checkCancel();
      PIMCP.progress("cosmetic", i, files.length, PIMCP.fs.basename(files[i]));
      var P = new CosmeticCorrection;
      P.targetFrames = [[true, files[i]]];
      P.outputDir = outDir;
      P.outputExtension = ".xisf";
      P.prefix = "";
      P.postfix = postfix;
      P.overwrite = true;
      P.cfa = args.cfa !== false;
      P.amount = Number(args.amount === undefined ? 1.0 : args.amount);
      P.useMasterDark = !!args.master_dark;
      P.masterDarkPath = args.master_dark || "";
      P.hotDarkCheck = !!args.master_dark && args.hot_dark_check !== false;
      P.hotDarkLevel = Number(args.hot_dark_level === undefined ? 0.5 : args.hot_dark_level);
      P.coldDarkCheck = !!args.master_dark && !!args.cold_dark_check;
      P.coldDarkLevel = Number(args.cold_dark_level === undefined ? 0.0 : args.cold_dark_level);
      P.useAutoDetect = args.auto_detect !== false;
      P.hotAutoCheck = args.auto_detect !== false;
      P.hotAutoValue = Number(args.hot_sigma === undefined ? 3.0 : args.hot_sigma);
      P.coldAutoCheck = !!args.cold_auto;
      P.coldAutoValue = Number(args.cold_sigma === undefined ? 3.0 : args.cold_sigma);
      if (args.params) PIMCP.assignParams(P, args.params);
      if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "CosmeticCorrection failed on " + files[i]);
      outs.push(outDir + "/" + PIMCP.fs.basename(files[i]) + postfix + ".xisf");
   }
   PIMCP.progress("cosmetic", files.length, files.length, "done");
   return { outputs: outs, cfa: args.cfa !== false, master_dark: args.master_dark || null, auto_detect: args.auto_detect !== false };
};

PIMCP.ops.debayer = function (args) {
   var files = PIMCP.req(args, "files");
   var outDir = PIMCP.req(args, "out_dir");
   PIMCP.assertFiles(files, "frames");
   PIMCP.fs.ensureDir(outDir);
   var outs = [], perFrame = [];
   var postfix = args.postfix || "_d";
   var pattern = args.pattern || "Auto";
   var method = args.method || "VNG";
   for (var i = 0; i < files.length; ++i) {
      PIMCP.checkCancel();
      PIMCP.progress("debayer", i, files.length, PIMCP.fs.basename(files[i]));
      var P = new Debayer;
      P.cfaPattern = PIMCP.enumOf(Debayer, pattern, "cfa pattern");
      P.debayerMethod = PIMCP.enumOf(Debayer, method, "debayer method");
      P.targetItems = [[true, files[i]]];
      P.outputDirectory = outDir;
      P.outputExtension = ".xisf";
      P.outputPostfix = postfix;
      P.overwriteExistingFiles = true;
      P.evaluateNoise = true;
      P.evaluateSignal = true;
      P.noGUIMessages = true;
      P.showImages = false;
      if (args.params) PIMCP.assignParams(P, args.params);
      if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "Debayer failed on " + files[i]);
      var od = P.outputFileData;
      var row = (od && od.length) ? od[0] : null;
      var outPath = row ? row[0] : (outDir + "/" + PIMCP.fs.basename(files[i]) + postfix + ".xisf");
      outs.push(outPath);
      perFrame.push({ input: files[i], output: outPath });
   }
   PIMCP.progress("debayer", files.length, files.length, "done");
   return { outputs: outs, pattern: pattern, method: method };
};
