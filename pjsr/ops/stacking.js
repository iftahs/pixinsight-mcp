// pjsr/ops/stacking.js — SubframeSelector, StarAlignment, LocalNormalization, ImageIntegration, DrizzleIntegration. ES5.

PIMCP.stack = {
   DEFAULT_APPROVAL: "FWHM <= FWHMMedian*1.25 && Eccentricity <= 0.60 && Stars >= 20",
   DEFAULT_WEIGHTING:
      "10*(1-(FWHM-FWHMMin)/(FWHMMax-FWHMMin+0.0001)) + " +
      "10*(1-(Eccentricity-EccentricityMin)/(EccentricityMax-EccentricityMin+0.0001)) + " +
      "20*(SNRWeight-SNRWeightMin)/(SNRWeightMax-SNRWeightMin+0.0001) + 50",

   measurementRow: function (m) {
      // index, enabled, locked, filePath, weight, FWHM, eccentricity, PSFSignalWeight, unused01, SNRWeight, median, medianMeanDev,
      // noise, noiseRatio, stars, starResidual, FWHMMeanDev, eccentricityMeanDev, starResidualMeanDev, azimuth, altitude,
      // PSFFlux, PSFFluxPower, PSFTotalMeanFlux, PSFTotalMeanPowerFlux, PSFCount, MStar, NStar, PSFSNR, PSFScale, PSFScaleSNR
      return {
         index: m[0], enabled: !!m[1], locked: !!m[2], path: m[3], weight: PIMCP.round(m[4], 4),
         fwhm: PIMCP.round(m[5], 4), eccentricity: PIMCP.round(m[6], 4), psf_signal_weight: PIMCP.round(m[7], 4),
         snr_weight: PIMCP.round(m[9], 4), median: PIMCP.round(m[10], 8), median_mean_dev: PIMCP.round(m[11], 8),
         noise: PIMCP.round(m[12], 8), noise_ratio: PIMCP.round(m[13], 4), stars: m[14], star_residual: PIMCP.round(m[15], 4),
         fwhm_mean_dev: PIMCP.round(m[16], 4), ecc_mean_dev: PIMCP.round(m[17], 4),
         psf_flux: m[21], psf_count: m[25], m_star: m[26], n_star: m[27], psf_snr: PIMCP.round(m[28], 4), psf_scale_snr: PIMCP.round(m[30], 4)
      };
   },

   configure: function (P, args) {
      // FWHM is reported in pixels (scale 1) so approval thresholds computed by Node are unambiguous; Node converts to arcsec.
      P.subframeScale = 1.0;
      P.cameraGain = Number(args.camera_gain || 1.0);
      P.cameraResolution = PIMCP.enumOf(SubframeSelector, "Bits16");
      P.scaleUnit = PIMCP.enumOf(SubframeSelector, "ArcSeconds");
      P.dataUnit = PIMCP.enumOf(SubframeSelector, "Normalized");
      P.psfFit = PIMCP.enumOf(SubframeSelector, "Moffat4");
      P.nonInteractive = true;
      P.fileCache = true;
      P.noNoiseAndSignalWarnings = true;
      if (args.params) PIMCP.assignParams(P, args.params);
   }
};

PIMCP.ops.measure_subframes = function (args) {
   var files = PIMCP.req(args, "files");
   PIMCP.assertFiles(files, "subframes");
   var P = new SubframeSelector;
   P.routine = PIMCP.enumOf(SubframeSelector, "MeasureSubframes");
   P.subframes = PIMCP.rows(files, function (f) { return [true, f, "", ""]; });
   PIMCP.stack.configure(P, args);
   P.approvalExpression = args.approval_expression || PIMCP.stack.DEFAULT_APPROVAL;
   P.weightingExpression = args.weighting_expression || PIMCP.stack.DEFAULT_WEIGHTING;
   PIMCP.progress("measure", 0, files.length, "SubframeSelector measuring");
   if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "SubframeSelector measurement failed");
   var ms = P.measurements, out = [];
   for (var i = 0; i < ms.length; ++i) out.push(PIMCP.stack.measurementRow(ms[i]));
   // Keep raw rows so output_subframes can write weights without re-measuring.
   PIMCP.stack.lastMeasurements = ms;
   PIMCP.progress("measure", files.length, files.length, "done");
   return { measurements: out, approval_expression: P.approvalExpression, weighting_expression: P.weightingExpression, pixel_scale: P.subframeScale };
};

/**
 * Write SSWEIGHT into approved frames. Accepts either the measurement rows from measure_subframes
 * (with 'enabled' flags and 'weight' possibly adjusted by Node) or re-measures.
 */
PIMCP.ops.output_subframes = function (args) {
   var files = PIMCP.req(args, "files");
   var outDir = PIMCP.req(args, "out_dir");
   PIMCP.assertFiles(files, "subframes");
   PIMCP.fs.ensureDir(outDir);
   // OutputSubframes needs measurements in the SAME instance (measurements is read-only from scripts):
   // measure first (file cache makes a repeat cheap), then switch the routine and write approved frames.
   var P = new SubframeSelector;
   P.routine = PIMCP.enumOf(SubframeSelector, "MeasureSubframes");
   P.subframes = PIMCP.rows(files, function (f) { return [true, f, "", ""]; });
   PIMCP.stack.configure(P, args);
   P.approvalExpression = args.approval_expression || PIMCP.stack.DEFAULT_APPROVAL;
   P.weightingExpression = args.weighting_expression || PIMCP.stack.DEFAULT_WEIGHTING;
   P.outputDirectory = outDir;
   P.outputExtension = ".xisf";
   P.outputPostfix = args.postfix || "_a";
   P.outputKeyword = "SSWEIGHT";
   P.overwriteExistingFiles = true;
   P.onError = PIMCP.enumOf(SubframeSelector, "Continue");
   PIMCP.progress("weights", 0, files.length, "measuring (cached) with approval: " + P.approvalExpression);
   if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "SubframeSelector measurement failed");
   P.routine = PIMCP.enumOf(SubframeSelector, "OutputSubframes");
   PIMCP.progress("weights", 0, files.length, "writing SSWEIGHT");
   if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "SubframeSelector output failed");
   var outs = [], rejected = [], rows = P.measurements;
   for (var i = 0; i < rows.length; ++i) {
      var m = PIMCP.stack.measurementRow(rows[i]);
      var outPath = outDir + "/" + PIMCP.fs.basename(rows[i][3]) + (args.postfix || "_a") + ".xisf";
      if (!rows[i][1] || !File.exists(outPath)) { rejected.push({ index: m.index, path: m.path, fwhm: m.fwhm, eccentricity: m.eccentricity, stars: m.stars }); continue; }
      outs.push({ index: m.index, input: rows[i][3], output: outPath, weight: m.weight, fwhm: m.fwhm, eccentricity: m.eccentricity, stars: m.stars });
   }
   PIMCP.progress("weights", files.length, files.length, "done");
   return { outputs: outs, rejected: rejected, approval_expression: P.approvalExpression, weighting_expression: P.weightingExpression };
};

/**
 * Write SSWEIGHT (computed by Node) into copies of the approved frames.
 * SubframeSelector does not evaluate weighting expressions when driven from a script (weights stay 0),
 * so weights are computed in Node from the measurements and stamped here.
 * args.items: [{ input, output, weight }]
 */
PIMCP.ops.write_weights = function (args) {
   var items = PIMCP.req(args, "items");
   if (!PIMCP.isArray(items) || !items.length) PIMCP.fail("BAD_ARGS", "items required");
   var outs = [];
   for (var i = 0; i < items.length; ++i) {
      PIMCP.checkCancel();
      var it = items[i];
      PIMCP.progress("weights", i, items.length, PIMCP.fs.basename(it.input));
      if (!File.exists(it.input)) PIMCP.fail("FILE_NOT_FOUND", "frame not found: " + it.input);
      var ws = ImageWindow.open(it.input);
      if (!ws || !ws.length) PIMCP.fail("OPEN_FAILED", "could not open " + it.input);
      var w = ws[0];
      try {
         var ks = w.keywords, kept = [];
         for (var k = 0; k < ks.length; ++k) if (ks[k].name !== (args.keyword || "SSWEIGHT")) kept.push(ks[k]);
         kept.push(new FITSKeyword(args.keyword || "SSWEIGHT", Number(it.weight).toFixed(6), "pixinsight-mcp subframe weight"));
         w.keywords = kept;
         PIMCP.fs.ensureDir(PIMCP.fs.dir(it.output));
         if (File.exists(it.output)) File.remove(it.output);
         if (!w.saveAs(it.output, false, false, false, false)) PIMCP.fail("SAVE_FAILED", "could not save " + it.output);
         outs.push({ input: it.input, output: it.output, weight: Number(it.weight) });
      } finally { w.forceClose(); }
   }
   PIMCP.progress("weights", items.length, items.length, "done");
   return { outputs: outs, keyword: args.keyword || "SSWEIGHT" };
};

/** Register frames one at a time to a reference (exact progress, cancellable). */
PIMCP.ops.register = function (args) {
   var files = PIMCP.req(args, "files");
   var ref = PIMCP.req(args, "reference");
   var outDir = PIMCP.req(args, "out_dir");
   PIMCP.assertFiles(files, "frames");
   if (!File.exists(ref)) PIMCP.fail("FILE_NOT_FOUND", "reference not found: " + ref);
   PIMCP.fs.ensureDir(outDir);
   var outs = [], failed = [], perFrame = [];
   var postfix = args.postfix || "_r";
   for (var i = 0; i < files.length; ++i) {
      PIMCP.checkCancel();
      PIMCP.progress("register", i, files.length, PIMCP.fs.basename(files[i]));
      var P = new StarAlignment;
      P.referenceImage = ref;
      P.referenceIsFile = true;
      P.targets = [[true, true, files[i]]];
      P.mode = PIMCP.enumOf(StarAlignment, "RegisterMatch");
      P.outputDirectory = outDir;
      P.outputExtension = ".xisf";
      P.outputPostfix = postfix;
      P.overwriteExistingFiles = true;
      P.generateDrizzleData = args.generate_drizzle !== false;
      P.distortionCorrection = !!args.distortion_correction;
      P.pixelInterpolation = PIMCP.enumOf(StarAlignment, args.interpolation || "Auto", "interpolation");
      P.clampingThreshold = 0.3;
      P.maxStars = Number(args.max_stars || 0);
      P.noGUIMessages = true;
      P.onError = PIMCP.enumOf(StarAlignment, "Continue");
      if (args.params) PIMCP.assignParams(P, args.params);
      var ok = false;
      try { ok = PIMCP.quiet(P).executeGlobal(); } catch (e) { ok = false; }
      var od = P.outputData;
      var row = (od && od.length && od[0][0]) ? od[0] : null;
      if (!ok || !row) { failed.push({ input: files[i], reason: "StarAlignment failed (not enough matching stars?)" }); continue; }
      var outPath = row[0];
      outs.push(outPath);
      perFrame.push({ input: files[i], output: outPath, pair_matches: row[2], inliers: row[3], rms_error: PIMCP.round(row[7], 4), rms_error_dev: PIMCP.round(row[8], 4),
                      drizzle: P.generateDrizzleData ? outPath.replace(/\.xisf$/i, ".xdrz") : null });
   }
   PIMCP.progress("register", files.length, files.length, "done");
   if (!outs.length) PIMCP.fail("REGISTRATION_FAILED", "no frame could be registered to " + ref);
   return { outputs: outs, failed: failed, per_frame: perFrame, reference: ref, drizzle_files: P.generateDrizzleData ? outs.map(function (p) { return p.replace(/\.xisf$/i, ".xdrz"); }) : [] };
};

PIMCP.ops.local_normalization = function (args) {
   var files = PIMCP.req(args, "files");
   var ref = PIMCP.req(args, "reference");
   var outDir = PIMCP.req(args, "out_dir");
   PIMCP.assertFiles(files, "frames");
   PIMCP.fs.ensureDir(outDir);
   var outs = [];
   for (var i = 0; i < files.length; ++i) {
      PIMCP.checkCancel();
      PIMCP.progress("normalize", i, files.length, PIMCP.fs.basename(files[i]));
      var P = new LocalNormalization;
      P.referencePathOrViewId = ref;
      P.referenceIsView = false;
      P.targetItems = [[true, files[i]]];
      P.scale = Number(args.scale || 256);
      P.generateNormalizationData = true;
      P.generateNormalizedImages = PIMCP.pp.enumOr(LocalNormalization, ["GenerateNormalizedImages_Never", "GenerateNormalizedImages_GlobalExecutionOnly", "GenerateNormalizedImages_ViewExecutionOnly"]);
      P.outputDirectory = outDir;
      P.overwriteExistingFiles = true;
      P.noGUIMessages = true;
      P.onError = PIMCP.enumOf(LocalNormalization, "OnError_Continue");
      if (args.params) PIMCP.assignParams(P, args.params);
      if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "LocalNormalization failed on " + files[i]);
      var od = P.outputData;
      var xnml = (od && od.length && od[0][0]) ? od[0][0] : (outDir + "/" + PIMCP.fs.basename(files[i]) + ".xnml");
      outs.push({ input: files[i], xnml: xnml });
   }
   PIMCP.progress("normalize", files.length, files.length, "done");
   return { outputs: outs, reference: ref, scale: Number(args.scale || 256) };
};

PIMCP.ops.integrate = function (args) {
   var files = PIMCP.req(args, "files");
   var out = PIMCP.req(args, "out");
   PIMCP.assertFiles(files, "registered frames");
   var n = files.length;
   if (n < 3 && !args.force) PIMCP.fail("TOO_FEW_FRAMES", "refusing to integrate " + n + " frames (< 3) without force:true");
   var drz = args.drizzle_files || [];
   var ln = args.lnorm_files || [];
   var P = new ImageIntegration;
   P.images = PIMCP.rows(files, function (f, i) { return [true, f, drz[i] || "", ln[i] || ""]; });
   P.combination = PIMCP.enumOf(ImageIntegration, args.combination || "Average", "combination");
   var rej = PIMCP.cal.pickRejection(n, args.rejection);
   P.rejection = rej.value;
   var normName = args.normalization || (ln.length ? "LocalNormalization" : "AdditiveWithScaling");
   P.normalization = PIMCP.enumOf(ImageIntegration, normName, "normalization");
   var rnName = args.rejection_normalization || (ln.length ? "LocalRejectionNormalization" : "Scale");
   P.rejectionNormalization = PIMCP.enumOf(ImageIntegration, rnName, "rejection normalization");
   var wName = args.weights || "PSFSignalWeight";
   if (wName === "SSWEIGHT" || wName === "KeywordWeight") { P.weightMode = PIMCP.enumOf(ImageIntegration, "KeywordWeight"); P.weightKeyword = "SSWEIGHT"; wName = "KeywordWeight:SSWEIGHT"; }
   else P.weightMode = PIMCP.enumOf(ImageIntegration, wName, "weight mode");
   P.generateRejectionMaps = true;
   P.generateIntegratedImage = true;
   P.generateDrizzleData = drz.length > 0;
   P.evaluateSNR = true;
   P.rangeClipLow = true; P.rangeLow = 0;
   P.rangeClipHigh = false;
   P.largeScaleClipHigh = !!args.large_scale_clip_high;
   P.showImages = true;
   P.noGUIMessages = true;
   P.useCache = true;
   if (args.sigma_low !== undefined) P.sigmaLow = Number(args.sigma_low);
   if (args.sigma_high !== undefined) P.sigmaHigh = Number(args.sigma_high);
   if (args.linear_fit_low !== undefined) P.linearFitLow = Number(args.linear_fit_low);
   if (args.linear_fit_high !== undefined) P.linearFitHigh = Number(args.linear_fit_high);
   if (args.params) PIMCP.assignParams(P, args.params);
   PIMCP.progress("integrate", 0, n, "ImageIntegration " + rej.name + " / " + normName + " / " + wName);
   if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "ImageIntegration failed");
   var stats = PIMCP.cal.integrationStats(P, n);
   var perImage = [];
   var idata = P.imageData || [];
   for (var i = 0; i < idata.length; ++i) {
      var r = idata[i];
      var N = PIMCP.num;
      perImage.push({ file: files[i], weight: [PIMCP.round(N(r[0]), 4), PIMCP.round(N(r[1]), 4), PIMCP.round(N(r[2]), 4)], rejected_low: N(r[3]) + N(r[4]) + N(r[5]), rejected_high: N(r[6]) + N(r[7]) + N(r[8]) });
   }
   var fin = PIMCP.cal.finishIntegration(P, out, !!args.keep_open, args.keep_rejection_maps !== false);
   return { path: fin.path, view_id: fin.view_id, rejection: rej.name, normalization: normName, rejection_normalization: rnName, weights: wName,
            stats: stats, per_image: perImage, rejection_maps: fin.rejection_maps, drizzle_updated: drz.length > 0 };
};

PIMCP.ops.drizzle_integrate = function (args) {
   var xdrz = PIMCP.req(args, "xdrz_files");
   var out = PIMCP.req(args, "out");
   PIMCP.assertFiles(xdrz, "drizzle data files");
   var ln = args.lnorm_files || [];
   var P = new DrizzleIntegration;
   P.inputData = PIMCP.rows(xdrz, function (f, i) { return [true, f, ln[i] || ""]; });
   P.scale = Number(args.scale || 2);
   P.dropShrink = Number(args.drop_shrink || 0.9);
   P.kernelFunction = PIMCP.enumOf(DrizzleIntegration, args.kernel || "Kernel_Square", "kernel");
   P.enableCFA = !!args.cfa;
   P.enableRejection = args.rejection !== false;
   P.enableImageWeighting = args.weighting !== false;
   P.enableLocalNormalization = ln.length > 0;
   P.enableSurfaceSplines = true;
   P.showImages = true;
   P.noGUIMessages = true;
   if (args.params) PIMCP.assignParams(P, args.params);
   PIMCP.progress("drizzle", 0, xdrz.length, "DrizzleIntegration x" + P.scale);
   if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "DrizzleIntegration failed");
   var w = ImageWindow.windowById(P.integrationImageId);
   if (!w || PIMCP.isNull(w)) PIMCP.fail("INTEGRATION_NO_OUTPUT", "DrizzleIntegration produced no image");
   PIMCP.fs.ensureDir(PIMCP.fs.dir(out));
   if (File.exists(out)) File.remove(out);
   w.saveAs(out, false, false, false, false);
   var weightPath = null;
   var ww = ImageWindow.windowById(P.weightImageId);
   if (ww && !PIMCP.isNull(ww)) {
      if (args.keep_weight_map) { weightPath = out.replace(/\.xisf$/i, "_drzweight.xisf"); if (File.exists(weightPath)) File.remove(weightPath); ww.saveAs(weightPath, false, false, false, false); }
      ww.forceClose();
   }
   var id = w.mainView.id;
   if (!args.keep_open) w.forceClose();
   var N = PIMCP.num;
   var px = N(P.outputPixels) || 0;
   var rl = (N(P.totalRejectedLowRK) || 0) + (N(P.totalRejectedLowG) || 0) + (N(P.totalRejectedLowB) || 0);
   var rh = (N(P.totalRejectedHighRK) || 0) + (N(P.totalRejectedHighG) || 0) + (N(P.totalRejectedHighB) || 0);
   return { path: out, view_id: args.keep_open ? id : null, scale: P.scale, drop_shrink: P.dropShrink, weight_map: weightPath,
            stats: { output_pixels: px, integrated_pixels: N(P.integratedPixels), rejected_low: rl, rejected_high: rh, total_data: N(P.totalData), output_range: [N(P.outputRangeLow), N(P.outputRangeHigh)] } };
};

/** FastIntegration: quick-look stack (register+integrate in one pass). */
PIMCP.ops.fast_integrate = function (args) {
   var files = PIMCP.req(args, "files");
   var out = PIMCP.req(args, "out");
   PIMCP.assertFiles(files, "frames");
   var P = new FastIntegration;
   P.referenceImage = args.reference || files[0];
   P.targets = PIMCP.rows(files, function (f) { return [true, f]; });
   P.generateImages = false;
   P.generateRejectionMaps = false;
   P.showImages = true;
   P.noGUIMessages = true;
   P.outputDirectory = PIMCP.fs.dir(out);
   if (args.params) PIMCP.assignParams(P, args.params);
   PIMCP.progress("fast_integrate", 0, files.length, "FastIntegration");
   if (!PIMCP.quiet(P).executeGlobal()) PIMCP.fail("PI_PROCESS_FAILED", "FastIntegration failed");
   var w = ImageWindow.windowById(P.integrationImageId);
   if (!w || PIMCP.isNull(w)) PIMCP.fail("INTEGRATION_NO_OUTPUT", "FastIntegration produced no image");
   if (File.exists(out)) File.remove(out);
   w.saveAs(out, false, false, false, false);
   var id = w.mainView.id;
   if (!args.keep_open) w.forceClose();
   return { path: out, view_id: args.keep_open ? id : null, number_of_images: PIMCP.num(P.numberOfImages) };
};
