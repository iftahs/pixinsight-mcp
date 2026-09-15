// pjsr/ops/blink.js — Blink-style frame review: contact sheet of auto-stretched thumbnails + per-frame metrics,
// so the agent can LOOK at every sub and drop clouds, trails, wind and focus slips before stacking.

PIMCP.ops.blink_contact_sheet = function (args) {
   var files = PIMCP.req(args, "files");
   var outPath = PIMCP.req(args, "out_path");
   PIMCP.assertFiles(files, "frames");
   var thumb = Number(args.thumb || 300);
   var cols = Number(args.columns || 5);
   var labelH = 16;
   var metrics = [];
   var thumbs = [];
   var maxW = 0, maxH = 0;
   for (var i = 0; i < files.length; ++i) {
      PIMCP.checkCancel();
      PIMCP.progress("blink", i, files.length, PIMCP.fs.basename(files[i]));
      var ws = ImageWindow.open(files[i]);
      if (!ws || !ws.length) { metrics.push({ index: i, file: files[i], error: "open failed" }); continue; }
      var w = ws[0];
      try {
         var v = w.mainView, img = v.image;
         // Quick metrics on a luminance copy (Image.resample takes scale factors, not sizes — keep full size).
         var small = new Image(img.width, img.height, 1, PIMCP.K.GRAY, 32, PIMCP.K.REAL);
         if (img.isColor) img.getLuminance(small); else small.assign(img);
         var med = small.median(), mad = small.MAD() * 1.4826;
         var nStars = 0, fwhm = null;
         try { var D = new StarDetector; D.sensitivity = 0.5; D.structureLayers = 4; var st = D.stars(small); nStars = st.length; } catch (e) { }
         var sat = 0;
         try { var h = new Histogram(256); h.generate(small); sat = h.count(255); } catch (e2) { }
         // Gradient proxy: median of left/right/top/bottom bands vs centre
         var W = small.width, H = small.height;
         function bandMed(x0, y0, x1, y1) { small.selectedRect = new Rect(x0, y0, x1, y1); var m = small.median(); small.resetSelections(); return m; }
         var l = bandMed(0, 0, Math.floor(W * 0.1), H), r = bandMed(Math.floor(W * 0.9), 0, W, H), t = bandMed(0, 0, W, Math.floor(H * 0.1)), b = bandMed(0, Math.floor(H * 0.9), W, H);
         var grad = Math.max(Math.abs(l - r), Math.abs(t - b)) / (med || 1e-9);
         small.free();
         metrics.push({ index: i, file: files[i], median: PIMCP.round(med, 6), mad: PIMCP.round(mad, 6), stars: nStars, saturated: sat, gradient: PIMCP.round(grad, 4) });
         // Thumbnail: stretched clone → bitmap
         var stf = PIMCP.stf.compute(v, "stf", true);
         var clone = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, PIMCP.win.uniqueId("pimcp_blink"));
         clone.mainView.beginProcess(PIMCP.K.NOSWAP); clone.mainView.image.assign(img); clone.mainView.endProcess();
         PIMCP.stf.applyAsHT(clone.mainView, stf);
         var bmp = clone.mainView.image.render();
         var sc = thumb / Math.max(bmp.width, bmp.height);
         bmp = bmp.scaledTo(Math.round(bmp.width * sc), Math.round(bmp.height * sc));
         clone.forceClose();
         thumbs.push({ index: i, bmp: bmp });
         if (bmp.width > maxW) maxW = bmp.width;
         if (bmp.height > maxH) maxH = bmp.height;
      } finally { w.forceClose(); }
   }
   // Flag outliers vs. group medians
   function medianOf(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); var m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
   var ok = metrics.filter(function (m) { return !m.error; });
   var medMed = medianOf(ok.map(function (m) { return m.median; })), medStars = medianOf(ok.map(function (m) { return m.stars; })), medGrad = medianOf(ok.map(function (m) { return m.gradient; }));
   var madMed = medianOf(ok.map(function (m) { return Math.abs(m.median - medMed); })) * 1.4826 || 1e-9;
   for (var k = 0; k < ok.length; ++k) {
      var m = ok[k], flags = [];
      if (Math.abs(m.median - medMed) > 3 * madMed && Math.abs(m.median - medMed) / medMed > 0.15) flags.push(m.median > medMed ? "bright background (clouds/moon/dawn?)" : "dark background");
      if (medStars > 0 && m.stars < 0.6 * medStars) flags.push("few stars (clouds/defocus?)");
      if (medGrad > 0 && m.gradient > 2.5 * medGrad && m.gradient > 0.15) flags.push("strong gradient (clouds/light leak?)");
      if (m.saturated > 0 && m.saturated > 50 * (medianOf(ok.map(function (x) { return x.saturated; })) + 1)) flags.push("many saturated pixels");
      m.flags = flags;
      m.suspect = flags.length > 0;
   }
   // Contact sheet
   var n = thumbs.length, rows = Math.ceil(n / cols);
   var cellW = maxW + 6, cellH = maxH + labelH + 6;
   var sheet = new Bitmap(cols * cellW, Math.max(1, rows) * cellH);
   sheet.fill(0xff181818);
   var g = new Graphics(sheet);
   g.font = new Font("Segoe UI", 11);
   for (var j = 0; j < n; ++j) {
      var c = j % cols, rr = Math.floor(j / cols);
      var x = c * cellW + 3, y = rr * cellH + 3;
      g.drawBitmap(x, y + labelH, thumbs[j].bmp);
      var mm = metrics[thumbs[j].index];
      var suspect = mm && mm.suspect;
      g.pen = new Pen(suspect ? 0xffff4040 : 0xffe0e0e0);
      g.drawText(x + 2, y + 12, "#" + thumbs[j].index + (mm ? "  bg " + mm.median.toFixed(4) + "  stars " + mm.stars : "") + (suspect ? "  !" : ""));
      if (suspect) { g.pen = new Pen(0xffff4040, 2); g.drawRect(x, y + labelH, x + thumbs[j].bmp.width - 1, y + labelH + thumbs[j].bmp.height - 1); }
   }
   g.end();
   PIMCP.fs.ensureDir(PIMCP.fs.dir(outPath));
   if (File.exists(outPath)) File.remove(outPath);
   sheet.save(outPath, Number(args.quality || 85));
   PIMCP.progress("blink", files.length, files.length, "done");
   return { path: outPath, width: sheet.width, height: sheet.height, columns: cols, thumb: thumb, metrics: metrics, group: { median_background: PIMCP.round(medMed, 6), median_stars: medStars, median_gradient: PIMCP.round(medGrad, 4) } };
};
