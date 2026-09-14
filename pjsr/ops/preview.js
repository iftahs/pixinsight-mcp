// pjsr/ops/preview.js — render JPEG previews of views without touching them. ES5.
//
// Strategy: duplicate the view into a temporary window, apply an AutoSTF permanently
// as a HistogramTransformation on the clone, render to Bitmap, scale, save JPEG, close clone.

PIMCP.preview = {
   /** Render a (sub)region of a view to a JPEG file. Returns {path,width,height,stf}. */
   render: function (view, opts) {
      opts = opts || {};
      var maxEdge = Number(opts.max_edge || 1024);
      var quality = Number(opts.quality || 85);
      var mode = opts.stretch || "stf";        // stf | hard | none
      var linked = opts.linked !== false;
      var outPath = PIMCP.req(opts, "out_path");
      var rect = opts.rect ? new Rect(Number(opts.rect[0]), Number(opts.rect[1]), Number(opts.rect[0]) + Number(opts.rect[2]), Number(opts.rect[1]) + Number(opts.rect[3])) : null;
      var src = view.image;
      if (rect) {
         rect = rect.intersection(new Rect(0, 0, src.width, src.height));
         if (rect.width <= 0 || rect.height <= 0) PIMCP.fail("BAD_ARGS", "rect is outside the image");
      }
      var w = null;
      try {
         var srcW = rect ? rect.width : src.width, srcH = rect ? rect.height : src.height;
         w = new ImageWindow(srcW, srcH, src.numberOfChannels, 32, true, src.isColor, PIMCP.win.uniqueId("pimcp_preview"));
         var cv = w.mainView;
         cv.beginProcess(UndoFlag_NoSwapFile);
         if (rect) {
            src.selectedRect = rect;
            cv.image.assign(src);       // assigns the selected region
            src.resetSelections();
         } else cv.image.assign(src);
         cv.endProcess();
         // Compute STF on the *full* view unless the caller wants the crop's own stretch.
         var stf = PIMCP.stf.compute(opts.stf_from_crop ? cv : view, mode, linked);
         if (mode !== "none") PIMCP.stf.applyAsHT(cv, stf);
         var bmp = cv.image.render();
         var scale = 1;
         var bw = bmp.width, bh = bmp.height;
         var longEdge = Math.max(bw, bh);
         if (opts.zoom && Number(opts.zoom) > 1) {
            scale = Number(opts.zoom);
            bmp = bmp.scaledTo(Math.round(bw * scale), Math.round(bh * scale), 0);
         } else if (longEdge > maxEdge) {
            scale = maxEdge / longEdge;
            bmp = bmp.scaledTo(Math.round(bw * scale), Math.round(bh * scale));
         }
         PIMCP.fs.ensureDir(PIMCP.fs.dir(outPath));
         if (File.exists(outPath)) File.remove(outPath);
         if (!bmp.save(outPath, quality)) PIMCP.fail("PREVIEW_SAVE_FAILED", "could not save " + outPath);
         return { path: outPath, width: bmp.width, height: bmp.height, scale: PIMCP.round(scale, 5), source_rect: rect ? [rect.x0, rect.y0, rect.width, rect.height] : [0, 0, src.width, src.height], stf: { mode: mode, linked: stf.linked, channels: stf.channels, median: stf.median } };
      } finally {
         if (w) w.forceClose();
      }
   }
};

PIMCP.ops.render_preview = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var r = PIMCP.preview.render(v, args);
   r.id = v.id;
   r.image_size = [v.image.width, v.image.height];
   return r;
};

PIMCP.ops.crop_preview = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   if (!args.rect) {
      // default: centred crop
      var size = Number(args.size || 512);
      var cx = args.center ? Number(args.center[0]) : Math.floor(v.image.width / 2);
      var cy = args.center ? Number(args.center[1]) : Math.floor(v.image.height / 2);
      args.rect = [Math.max(0, cx - Math.floor(size / 2)), Math.max(0, cy - Math.floor(size / 2)), size, size];
   }
   if (!args.max_edge) args.max_edge = 4096; // 1:1 by default
   var r = PIMCP.preview.render(v, args);
   r.id = v.id;
   return r;
};

/** Side-by-side comparison of two views (or one view and a checkpoint file). */
PIMCP.ops.compare_previews = function (args) {
   var a = PIMCP.win.view(PIMCP.req(args, "id_a"));
   var openedB = null, b;
   if (args.id_b) b = PIMCP.win.view(args.id_b);
   else if (args.path_b) { openedB = PIMCP.win.open(args.path_b, PIMCP.win.uniqueId("pimcp_cmp_b")); b = openedB.mainView; }
   else PIMCP.fail("BAD_ARGS", "id_b or path_b required");
   var tmpA = PIMCP.fs.dir(args.out_path) + "/_cmp_a.jpg", tmpB = PIMCP.fs.dir(args.out_path) + "/_cmp_b.jpg";
   var half = Math.floor(Number(args.max_edge || 1024) / 2);
   try {
      var ra = PIMCP.preview.render(a, { out_path: tmpA, max_edge: half, stretch: args.stretch, rect: args.rect, linked: args.linked });
      var rb = PIMCP.preview.render(b, { out_path: tmpB, max_edge: half, stretch: args.stretch, rect: args.rect, linked: args.linked });
      var ba = new Bitmap(tmpA), bb = new Bitmap(tmpB);
      var H = Math.max(ba.height, bb.height), W = ba.width + bb.width + 8;
      var out = new Bitmap(W, H);
      out.fill(0xff202020);
      var g = new Graphics(out);
      g.drawBitmap(0, 0, ba);
      g.drawBitmap(ba.width + 8, 0, bb);
      g.pen = new Pen(0xffffffff);
      g.font = new Font("Segoe UI", 12);
      g.drawText(6, 16, args.label_a || a.id);
      g.drawText(ba.width + 14, 16, args.label_b || (args.id_b || "file"));
      g.end();
      if (File.exists(args.out_path)) File.remove(args.out_path);
      out.save(args.out_path, Number(args.quality || 85));
      return { path: args.out_path, width: W, height: H, a: { id: a.id, stf: ra.stf }, b: { id: b.id, stf: rb.stf } };
   } finally {
      try { File.remove(tmpA); } catch (e) { }
      try { File.remove(tmpB); } catch (e2) { }
      if (openedB) openedB.forceClose();
   }
};
