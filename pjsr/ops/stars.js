// pjsr/ops/stars.js — star detection and PSF measurement on an open view. ES5.

// StarDetector is a native class under #engine v8 (PixInsight 1.9); including pjsr/StarDetector.jsh would shadow it
// with the JS version and break ImageSolver (PSF.fitStars expects StarData objects).

PIMCP.stars = {
   /** Detect stars on a (luminance) image. Returns array of {x,y,flux,size,bkg}. */
   detect: function (img, opts) {
      opts = opts || {};
      var D = new StarDetector;
      D.structureLayers = Number(opts.structure_layers || 5);
      D.sensitivity = Number(opts.sensitivity || 0.5);
      D.peakResponse = Number(opts.peak_response || 0.5);
      D.maxDistortion = Number(opts.max_distortion || 0.6);
      D.upperLimit = Number(opts.upper_limit || 1.0);
      D.hotPixelFilterRadius = 1;
      D.noiseReductionFilterRadius = 0;
      var work = img;
      var tmp = null;
      if (img.isColor) {
         tmp = new Image(img.width, img.height, 1, ColorSpace_Gray, 32, SampleType_Real);
         img.getLuminance(tmp);
         work = tmp;
      }
      var stars = D.stars(work);
      if (tmp) tmp.free();
      var out = [];
      for (var i = 0; i < stars.length; ++i) {
         var s = stars[i];
         // Star objects: {pos, flux, size[, bkg, rect]} depending on engine/version. Build a fitting box from size.
         var half = s.rect ? 0 : Math.max(5, Math.ceil(Math.sqrt(s.size || 25) * 0.9));
         var rect = s.rect ? [s.rect.x0, s.rect.y0, s.rect.width, s.rect.height]
                           : [Math.max(0, Math.round(s.pos.x) - half), Math.max(0, Math.round(s.pos.y) - half), 2 * half + 1, 2 * half + 1];
         out.push({ x: PIMCP.round(s.pos.x, 2), y: PIMCP.round(s.pos.y, 2), flux: PIMCP.round(s.flux, 6), bkg: (s.bkg === undefined) ? null : PIMCP.round(s.bkg, 6), size: s.size, rect: rect });
      }
      out.sort(function (a, b) { return b.flux - a.flux; });
      return out;
   },

   /** Fit PSFs with DynamicPSF on the brightest N stars of a view. */
   fitPSF: function (view, stars, maxStars) {
      var P = new DynamicPSF;
      P.views = [[view.id]];
      var rows = [];
      var n = Math.min(stars.length, maxStars || 200);
      for (var i = 0; i < n; ++i) {
         var s = stars[i];
         var r = s.rect;
         // viewIndex, channel, status, x0, y0, x1, y1, x, y
         rows.push([0, 0, 0, r[0], r[1], r[0] + r[2], r[1] + r[3], s.x, s.y]);
      }
      P.stars = rows;
      P.autoPSF = false; P.gaussianPSF = false; P.moffatPSF = false; P.moffat4PSF = true;
      P.circularPSF = false; P.astrometry = false; P.regenerate = true; P.autoAperture = true;
      P.searchRadius = 8; P.threshold = 1.0;
      if (!P.executeGlobal()) PIMCP.fail("DYNAMICPSF_FAILED", "DynamicPSF failed");
      var fits = [];
      var psf = P.psf;
      var okStatus = (typeof DynamicPSF.PSF_FittedOk === "number") ? DynamicPSF.PSF_FittedOk : 1;
      var saturated = 0;
      for (i = 0; i < psf.length; ++i) {
         var f = psf[i];
         // starIndex, function, circular, status, B, A, cx, cy, sx, sy, theta, beta, mad, ...
         var status = f[3];
         if (status !== okStatus) continue;
         if (f[5] + f[4] > 0.95) { saturated++; continue; }   // clipped core: FWHM meaningless
         var sx = f[8], sy = f[9], beta = f[11];
         var k = 2 * Math.sqrt(Math.pow(2, 1 / beta) - 1);   // Moffat FWHM factor
         if (!(beta > 0)) k = 2.354820045;                    // Gaussian fallback
         var fx = k * sx, fy = k * sy;
         var ecc = (sx > 0 && sy > 0) ? Math.sqrt(1 - Math.pow(Math.min(sx, sy) / Math.max(sx, sy), 2)) : null;
         fits.push({ x: PIMCP.round(f[6], 2), y: PIMCP.round(f[7], 2), fwhm_x: PIMCP.round(fx, 3), fwhm_y: PIMCP.round(fy, 3), fwhm: PIMCP.round(Math.sqrt(fx * fy), 3),
                     eccentricity: ecc === null ? null : PIMCP.round(ecc, 3), amplitude: PIMCP.round(f[5], 6), background: PIMCP.round(f[4], 6), beta: PIMCP.round(beta, 3), mad: PIMCP.round(f[12], 6), theta: PIMCP.round(f[10], 2) });
      }
      fits.saturated = saturated;
      return fits;
   },

   median: function (arr) {
      if (!arr.length) return null;
      var a = arr.slice().sort(function (x, y) { return x - y; });
      var m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
   }
};

PIMCP.ops.measure_stars = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var img = v.image;
   var t0 = Date.now();
   var stars = PIMCP.stars.detect(img, args);
   var maxFit = Number(args.max_psf_fits || 200);
   var fits = [];
   var fitErr = null;
   if (args.fit_psf !== false && stars.length) {
      // Skip the very brightest (likely saturated) 1% and fit the next maxFit stars.
      var skip = Math.min(50, Math.floor(stars.length * 0.01));
      try { fits = PIMCP.stars.fitPSF(v, stars.slice(skip), maxFit); } catch (e) { fitErr = String(e); }
   }
   var fw = [], ec = [];
   for (var i = 0; i < fits.length; ++i) { fw.push(fits[i].fwhm); if (fits[i].eccentricity !== null) ec.push(fits[i].eccentricity); }
   var scale = args.pixel_scale ? Number(args.pixel_scale) : null;
   var medF = PIMCP.stars.median(fw), medE = PIMCP.stars.median(ec);
   // FWHM spread across the field: compare centre vs corners (simple aberration check)
   var cx = img.width / 2, cy = img.height / 2, rmax = Math.sqrt(cx * cx + cy * cy);
   var inner = [], outer = [];
   for (i = 0; i < fits.length; ++i) {
      var d = Math.sqrt(Math.pow(fits[i].x - cx, 2) + Math.pow(fits[i].y - cy, 2)) / rmax;
      (d < 0.4 ? inner : outer).push(fits[i].fwhm);
   }
   return {
      id: v.id, star_count: stars.length, fitted: fits.length, saturated_skipped: fits.saturated || 0, fit_error: fitErr,
      median_fwhm_px: medF, median_fwhm_arcsec: (medF !== null && scale) ? PIMCP.round(medF * scale, 3) : null,
      median_eccentricity: medE,
      fwhm_center_px: PIMCP.stars.median(inner), fwhm_edge_px: PIMCP.stars.median(outer),
      brightest: stars.slice(0, 10), sample_fits: fits.slice(0, Number(args.return_fits || 10)),
      elapsed_ms: Date.now() - t0
   };
};
