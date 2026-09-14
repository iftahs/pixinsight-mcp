// pjsr/lib/stf.js — auto screen-transfer-function (the standard PixInsight AutoSTF) and
// application of an STF as a permanent HistogramTransformation. ES5.

PIMCP.stf = {
   SHADOWS_CLIP: -2.80,   // in MAD units below the median
   TARGET_BKG: 0.25,      // target background after stretch

   /**
    * Compute AutoSTF parameters for a view. Returns { linked, channels:[{c0,m,c1}], ... }.
    * mode: "stf" (default AutoSTF), "hard" (more aggressive), "none" (identity).
    */
   compute: function (view, mode, linked) {
      var img = view.image;
      var n = img.isColor ? 3 : 1;
      var shadows = PIMCP.stf.SHADOWS_CLIP, target = PIMCP.stf.TARGET_BKG;
      if (mode === "hard") { shadows = -1.25; target = 0.40; }
      if (linked === undefined) linked = true;
      var med = [], mad = [];
      for (var c = 0; c < n; ++c) {
         img.selectedChannel = c;
         med.push(img.median());
         mad.push(img.MAD() * 1.4826);
      }
      img.resetSelections();
      var chans = [];
      if (mode === "none") {
         for (c = 0; c < n; ++c) chans.push({ c0: 0, m: 0.5, c1: 1 });
         return { linked: true, channels: chans, median: med, mad: mad, mode: mode };
      }
      if (linked || n === 1) {
         var mm = 0, ma = 0;
         for (c = 0; c < n; ++c) { mm += med[c]; ma += mad[c]; }
         mm /= n; ma /= n;
         var c0 = (mm + shadows * ma > 0) ? mm + shadows * ma : 0;
         var m = Math.mtf(target, mm - c0);
         for (c = 0; c < n; ++c) chans.push({ c0: c0, m: m, c1: 1 });
      } else {
         for (c = 0; c < n; ++c) {
            var cc0 = (med[c] + shadows * mad[c] > 0) ? med[c] + shadows * mad[c] : 0;
            chans.push({ c0: cc0, m: Math.mtf(target, med[c] - cc0), c1: 1 });
         }
      }
      return { linked: linked, channels: chans, median: med, mad: mad, mode: mode };
   },

   /** Apply STF params permanently to a view via HistogramTransformation. */
   applyAsHT: function (view, stf) {
      var H = [];
      var img = view.image;
      var ch = stf.channels;
      if (img.isColor && !stf.linked) {
         for (var c = 0; c < 3; ++c) H.push([ch[c].c0, ch[c].m, ch[c].c1, 0, 1]);
         H.push([0, 0.5, 1, 0, 1]);
      } else {
         H.push([0, 0.5, 1, 0, 1]); H.push([0, 0.5, 1, 0, 1]); H.push([0, 0.5, 1, 0, 1]);
         H.push([ch[0].c0, ch[0].m, ch[0].c1, 0, 1]);
      }
      H.push([0, 0.5, 1, 0, 1]);
      var P = new HistogramTransformation;
      P.H = H;
      if (!P.executeOn(view, false)) PIMCP.fail("HT_FAILED", "HistogramTransformation failed");
   },

   /** Set the on-screen STF of a view (non-destructive) — makes the GUI show a stretched image. */
   applyToScreen: function (view, stf) {
      var rows = [];
      var ch = stf.channels;
      for (var c = 0; c < 3; ++c) {
         var s = ch[Math.min(c, ch.length - 1)];
         rows.push([s.c0, s.c1, s.m, 0, 1]);
      }
      rows.push([0, 1, 0.5, 0, 1]);
      var P = new ScreenTransferFunction;
      P.STF = rows;
      P.executeOn(view, false);
   }
};
