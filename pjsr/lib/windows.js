// pjsr/lib/windows.js — image window / view helpers. ES5.

PIMCP.win = {
   /** Find a view by id; throws VIEW_NOT_FOUND. */
   view: function (id) {
      if (!id) PIMCP.fail("BAD_ARGS", "view id required");
      var v = View.viewById(id);
      if (!v || PIMCP.isNull(v)) PIMCP.fail("VIEW_NOT_FOUND", "no open view with id '" + id + "'. Use list_windows or open_image.");
      return v;
   },
   window: function (id) {
      var w = ImageWindow.windowById(id);
      if (!w || PIMCP.isNull(w)) {
         var v = View.viewById(id);
         if (v && !PIMCP.isNull(v)) return v.window;
         PIMCP.fail("VIEW_NOT_FOUND", "no open window/view with id '" + id + "'");
      }
      return w;
   },
   /** Open an image file; returns the main view id. Optionally rename the view. */
   open: function (path, id) {
      if (!File.exists(path)) PIMCP.fail("FILE_NOT_FOUND", "file not found: " + path);
      var ws = ImageWindow.open(path);
      if (!ws || ws.length === 0) PIMCP.fail("OPEN_FAILED", "PixInsight could not open " + path);
      var w = ws[0];
      for (var i = 1; i < ws.length; ++i) ws[i].forceClose(); // multi-image containers: keep first
      if (id) w.mainView.id = PIMCP.win.safeId(id);
      w.show();
      return w;
   },
   safeId: function (id) {
      var s = String(id).replace(/[^A-Za-z0-9_]/g, "_");
      if (!/^[A-Za-z_]/.test(s)) s = "_" + s;
      return s;
   },
   uniqueId: function (base) {
      var id = PIMCP.win.safeId(base), i = 1;
      while (!PIMCP.isNull(View.viewById(id))) id = PIMCP.win.safeId(base) + "_" + (i++);
      return id;
   },
   /** Deep copy a view into a new window (no history). */
   duplicate: function (view, newId) {
      var img = view.image;
      var w = new ImageWindow(img.width, img.height, img.numberOfChannels, img.bitsPerSample, img.isReal, img.isColor, PIMCP.win.uniqueId(newId || (view.id + "_copy")));
      w.mainView.beginProcess(UndoFlag_NoSwapFile);
      w.mainView.image.assign(img);
      w.mainView.endProcess();
      // Preserve keywords and astrometric solution where possible.
      try { w.keywords = view.window.keywords; } catch (e) { }
      try { if (view.window.hasAstrometricSolution) w.copyAstrometricSolution(view.window); } catch (e2) { }
      return w;
   },
   close: function (id, force) {
      var w = PIMCP.win.window(id);
      if (force) w.forceClose(); else w.close();
      return true;
   },
   list: function () {
      var out = [];
      var ws = ImageWindow.windows;
      for (var i = 0; i < ws.length; ++i) {
         var w = ws[i];
         if (PIMCP.isNull(w)) continue;
         var v = w.mainView, img = v.image;
         out.push({
            id: v.id,
            width: img.width, height: img.height, channels: img.numberOfChannels,
            color_space: PIMCP.win.colorSpaceName(img.colorSpace),
            is_color: img.isColor,
            bits_per_sample: img.bitsPerSample, is_float: img.isReal,
            file_path: w.filePath || null,
            modified: w.isModified,
            has_astrometric_solution: w.hasAstrometricSolution,
            has_mask: !PIMCP.isNull(w.mask),
            previews: w.previews.length,
            linear_guess: PIMCP.win.linearGuess(img)
         });
      }
      return out;
   },
   colorSpaceName: function (cs) {
      switch (cs) {
         case ColorSpace_Gray: return "Gray";
         case ColorSpace_RGB: return "RGB";
         case ColorSpace_CIEXYZ: return "CIEXYZ";
         case ColorSpace_CIELab: return "CIELab";
         case ColorSpace_CIELch: return "CIELch";
         case ColorSpace_HSV: return "HSV";
         case ColorSpace_HSI: return "HSI";
         default: return String(cs);
      }
   },
   /** Heuristic: a linear deep-sky image has a median far below 0.1. */
   linearGuess: function (img) {
      try {
         var m = img.median();
         return { linear: m < 0.08, median: PIMCP.round(m, 6) };
      } catch (e) { return { linear: null }; }
   },
   /** Save a view to a path in a given format (by extension). */
   save: function (view, path, opts) {
      opts = opts || {};
      var w = view.window;
      var dir = PIMCP.fs.dir(path);
      PIMCP.fs.ensureDir(dir);
      if (File.exists(path) && !opts.overwrite) PIMCP.fail("EXISTS", "refusing to overwrite existing file " + path + " (pass overwrite:true)");
      var ok = w.saveAs(path, false, false, false, false);
      if (!ok) PIMCP.fail("SAVE_FAILED", "saveAs returned false for " + path);
      return path;
   }
};
