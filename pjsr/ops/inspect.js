// pjsr/ops/inspect.js — statistics, histogram, FITS keywords. Never modifies the view. ES5.

PIMCP.ops.image_statistics = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var img = v.image;
   var n = img.numberOfChannels;
   var chans = [];
   var names = img.isColor ? ["R", "G", "B"] : ["K"];
   var total = img.width * img.height;
   var rect = null;
   if (args.rect) {
      rect = new Rect(Number(args.rect[0]), Number(args.rect[1]), Number(args.rect[0]) + Number(args.rect[2]), Number(args.rect[1]) + Number(args.rect[3]));
      total = rect.width * rect.height;
   }
   var clipLow = (args.clip_low === undefined) ? 0 : Number(args.clip_low);
   var clipHigh = (args.clip_high === undefined) ? 1 : Number(args.clip_high);
   for (var c = 0; c < n; ++c) {
      img.selectedChannel = c;
      if (rect) img.selectedRect = rect;
      var med = img.median(), mad = img.MAD(), mean = img.mean(), sd = img.stdDev(), mn = img.minimum(), mx = img.maximum(), avgDev = img.avgDev();
      var h = new Histogram(65536); h.generate(img);
      var zeroCount = 0, satCount = 0;
      // count bins at/below clipLow and at/above clipHigh
      var lowBin = Math.floor(clipLow * 65535), highBin = Math.ceil(clipHigh * 65535);
      for (var b = 0; b <= lowBin; ++b) zeroCount += h.count(b);
      for (b = highBin; b < 65536; ++b) satCount += h.count(b);
      var noise = null, noiseFrac = null, noiseAlgo = null;
      try {
         var nm = img.noiseMRS();       // [sigma, count]
         if (nm && nm[1] > 0) { noise = nm[0]; noiseFrac = nm[1] / total; noiseAlgo = "MRS"; }
      } catch (e) { }
      if (noise === null) {
         try { var nk = img.noiseKSigma(); noise = nk[0]; noiseFrac = nk[1] / total; noiseAlgo = "K-Sigma"; } catch (e2) { }
      }
      chans.push({
         channel: names[c] || String(c),
         median: PIMCP.round(med, 8), mad: PIMCP.round(mad, 8), mad_normalized: PIMCP.round(mad * 1.4826, 8),
         mean: PIMCP.round(mean, 8), std_dev: PIMCP.round(sd, 8), avg_dev: PIMCP.round(avgDev, 8),
         min: PIMCP.round(mn, 8), max: PIMCP.round(mx, 8),
         clipped_low_count: zeroCount, clipped_low_pct: PIMCP.round(100 * zeroCount / total, 4),
         saturated_count: satCount, saturated_pct: PIMCP.round(100 * satCount / total, 4),
         noise_sigma: noise === null ? null : PIMCP.round(noise, 9), noise_fraction: noiseFrac === null ? null : PIMCP.round(noiseFrac, 4), noise_algorithm: noiseAlgo,
         snr_proxy: (noise && noise > 0) ? PIMCP.round(med / noise, 3) : null
      });
   }
   img.resetSelections();
   var out = { id: v.id, width: img.width, height: img.height, channels: chans, pixels: total, rect: args.rect || null };
   if (img.isColor && chans.length === 3) {
      var mr = chans[0].median, mg = chans[1].median, mb = chans[2].median;
      var mx3 = Math.max(mr, mg, mb), mn3 = Math.min(mr, mg, mb);
      out.background_neutrality = { r_over_g: PIMCP.round(mr / mg, 4), b_over_g: PIMCP.round(mb / mg, 4), max_min_ratio: PIMCP.round(mx3 / (mn3 || 1e-12), 4) };
   }
   out.linear_guess = PIMCP.win.linearGuess(img);
   return out;
};

PIMCP.ops.histogram = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var img = v.image;
   var bins = Number(args.bins || 256);
   var n = img.numberOfChannels;
   var names = img.isColor ? ["R", "G", "B"] : ["K"];
   var out = [];
   for (var c = 0; c < n; ++c) {
      img.selectedChannel = c;
      var h = new Histogram(bins); h.generate(img);
      var counts = [];
      for (var b = 0; b < bins; ++b) counts.push(h.count(b));
      out.push({ channel: names[c] || String(c), counts: counts, peak_bin: h.peakLevel, total: h.totalCount });
   }
   img.resetSelections();
   return { id: v.id, bins: bins, channels: out };
};

PIMCP.ops.keywords = function (args) {
   var w = PIMCP.win.window(PIMCP.req(args, "id"));
   var ks = w.keywords, out = [];
   for (var i = 0; i < ks.length; ++i) out.push({ name: ks[i].name, value: ks[i].strippedValue, comment: ks[i].comment });
   var props = {};
   try {
      var ids = w.mainView.properties;
      for (i = 0; i < ids.length; ++i) {
         var val = w.mainView.propertyValue(ids[i]);
         if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") props[ids[i]] = val;
      }
   } catch (e) { }
   return { id: w.mainView.id, keywords: out, properties: props, astrometric_solution: w.hasAstrometricSolution ? w.astrometricSolutionSummary() : null };
};
