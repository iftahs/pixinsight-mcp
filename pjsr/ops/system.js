// pjsr/ops/system.js — ping, capabilities, raw script execution, console. ES5.

PIMCP.ops = PIMCP.ops || {};

PIMCP.ops.ping = function (args) {
   return { pong: true, t: PIMCP.nowIso(), echo: args.echo === undefined ? null : args.echo };
};

/** Which optional processes / scripts are available in this PixInsight. */
PIMCP.ops.capabilities = function () {
   var procs = ["BlurXTerminator", "NoiseXTerminator", "StarXTerminator", "StarNet", "StarNet2", "GraXpert",
                "GradientCorrection", "SpectrophotometricColorCalibration", "PhotometricColorCalibration",
                "MultiscaleAdaptiveStretch", "GeneralizedHyperbolicStretch", "DrizzleIntegration", "LocalNormalization",
                "SubframeSelector", "StarAlignment", "ImageIntegration", "ImageCalibration", "CosmeticCorrection", "Debayer",
                "Deconvolution", "TGVDenoise", "MultiscaleLinearTransform", "DynamicPSF", "FastIntegration", "ArcsinhStretch",
                "MaskedStretch", "AutomaticBackgroundExtractor", "DynamicBackgroundExtraction", "CometAlignment", "Annotation"];
   var out = {};
   for (var i = 0; i < procs.length; ++i) out[procs[i]] = PIMCP.hasProcess(procs[i]);
   var srcDir = CoreApplication.srcDirPath + "/scripts";
   var scripts = {
      WBPP: File.exists(srcDir + "/BatchPreprocessing/WBPP.js"),
      ImageSolver: File.exists(srcDir + "/AdP/ImageSolver.js"),
      AnnotateImage: File.exists(srcDir + "/AdP/AnnotateImage.js") || File.exists(srcDir + "/AnnotateImage/AnnotateImage.js")
   };
   return {
      pi_version: CoreApplication.versionMajor + "." + CoreApplication.versionMinor + "." + CoreApplication.versionRelease,
      codename: CoreApplication.versionCodename,
      platform: CoreApplication.platform,
      pid: Number(CoreApplication.pid),
      processes: out,
      scripts: scripts,
      src_dir: srcDir,
      open_windows: PIMCP.win.list().length
   };
};

/** Execute arbitrary PJSR source. The script may `return` a value via the special variable `result`. */
PIMCP.ops.run_pjsr = function (args) {
   var src = PIMCP.req(args, "script");
   var result;
   // Wrap so the script can either assign `result = ...` or evaluate to a value.
   var fn = new Function("PIMCP", "args", "var result; " + src + "\n; return result;");
   var out = fn(PIMCP, args.script_args || {});
   if (out === undefined) {
      // Fallback: evaluate as an expression if the last statement produced a value.
      try { out = eval(src); } catch (e) { out = null; }
   }
   // Make sure the value is JSON-serialisable.
   try { out = JSON.parse(PIMCP.toJSON(out)); } catch (e2) { out = String(out); }
   return { result: (out === undefined) ? null : out };
};

PIMCP.ops.list_windows = function () {
   return { windows: PIMCP.win.list() };
};

PIMCP.ops.open_image = function (args) {
   var path = PIMCP.req(args, "path");
   var w = PIMCP.win.open(path, args.id);
   var v = w.mainView, img = v.image;
   var kw = [];
   try {
      var ks = w.keywords;
      for (var i = 0; i < ks.length; ++i) kw.push({ name: ks[i].name, value: ks[i].strippedValue, comment: ks[i].comment });
   } catch (e) { }
   return { id: v.id, width: img.width, height: img.height, channels: img.numberOfChannels, is_color: img.isColor,
            color_space: PIMCP.win.colorSpaceName(img.colorSpace), bits_per_sample: img.bitsPerSample, is_float: img.isReal,
            file_path: w.filePath, keywords: kw, linear_guess: PIMCP.win.linearGuess(img), has_astrometric_solution: w.hasAstrometricSolution };
};

PIMCP.ops.close_window = function (args) {
   var id = PIMCP.req(args, "id");
   PIMCP.win.close(id, args.force !== false);
   return { closed: id };
};

PIMCP.ops.close_all = function (args) {
   var ws = ImageWindow.windows, n = 0;
   for (var i = 0; i < ws.length; ++i) { try { ws[i].forceClose(); n++; } catch (e) { } }
   return { closed: n };
};

PIMCP.ops.duplicate_window = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var w = PIMCP.win.duplicate(v, args.new_id);
   w.show();
   return { id: w.mainView.id, source: v.id };
};

PIMCP.ops.save_image = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var path = PIMCP.req(args, "path");
   var bits = args.bit_depth;
   var hints = "";
   if (bits) {
      var ext = PIMCP.fs.ext(path).toLowerCase();
      if (ext === ".tif" || ext === ".tiff" || ext === ".png") {
         // Convert a copy to the requested integer sample format for 8/16-bit formats.
         var w = PIMCP.win.duplicate(v, "pimcp_save_tmp");
         try {
            w.setSampleFormat(Number(bits), false);
            PIMCP.win.save(w.mainView, path, { overwrite: !!args.overwrite });
         } finally { w.forceClose(); }
         return { saved: path };
      }
   }
   PIMCP.win.save(v, path, { overwrite: !!args.overwrite });
   return { saved: path };
};

/** Write a checkpoint copy of a view as XISF into a directory; returns path. */
PIMCP.checkpoint = function (view, dir, label) {
   PIMCP.fs.ensureDir(dir);
   var stamp = (new Date()).toISOString().replace(/[:.]/g, "-");
   var path = dir + "/" + PIMCP.win.safeId(view.id) + "_" + (label || "ckpt") + "_" + stamp + ".xisf";
   var w = view.window;
   var ok = w.saveAs(path, false, false, false, false);
   if (!ok) PIMCP.fail("CHECKPOINT_FAILED", "could not write checkpoint " + path);
   // saveAs re-associates the window with the checkpoint file; that's acceptable (it's a copy on disk).
   return path;
};

PIMCP.ops.checkpoint = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   return { checkpoint: PIMCP.checkpoint(v, PIMCP.req(args, "dir"), args.label) };
};

/** Restore a checkpoint into an existing view (in place) or as a new window. */
PIMCP.ops.restore_checkpoint = function (args) {
   var path = PIMCP.req(args, "path");
   if (!File.exists(path)) PIMCP.fail("FILE_NOT_FOUND", "checkpoint not found: " + path);
   var target = args.id;
   if (target && !PIMCP.isNull(View.viewById(target))) {
      var v = View.viewById(target);
      var ws = ImageWindow.open(path);
      if (!ws.length) PIMCP.fail("OPEN_FAILED", "could not open " + path);
      var src = ws[0];
      try {
         v.beginProcess(UndoFlag_NoSwapFile);
         v.image.assign(src.mainView.image);
         v.endProcess();
         try { v.window.keywords = src.keywords; } catch (e) { }
      } finally { src.forceClose(); }
      return { id: v.id, restored_from: path, mode: "in_place" };
   }
   var w = PIMCP.win.open(path, target);
   return { id: w.mainView.id, restored_from: path, mode: "new_window" };
};

PIMCP.ops.undo = function (args) {
   var w = PIMCP.win.window(PIMCP.req(args, "id"));
   var n = Number(args.steps || 1);
   for (var i = 0; i < n; ++i) w.undo();
   return { id: w.mainView.id, undone: n };
};

PIMCP.ops.set_screen_stf = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var stf = PIMCP.stf.compute(v, args.mode || "stf", args.linked !== false);
   PIMCP.stf.applyToScreen(v, stf);
   return { id: v.id, stf: stf };
};
