// pjsr/ops/masks.js — star masks, range masks, mask application. ES5.

PIMCP.ops.star_mask = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var before = {};
   var ws = ImageWindow.windows;
   for (var i = 0; i < ws.length; ++i) before[ws[i].mainView.id] = true;
   var P = new StarMask;
   P.waveletLayers = Number(args.layers || 5);
   P.noiseThreshold = Number(args.noise_threshold === undefined ? 0.1 : args.noise_threshold);
   P.largeScaleGrowth = Number(args.large_growth === undefined ? 2 : args.large_growth);
   P.smallScaleGrowth = Number(args.small_growth === undefined ? 1 : args.small_growth);
   P.smoothness = Number(args.smoothness === undefined ? 16 : args.smoothness);
   P.midtonesBalance = Number(args.midtones === undefined ? 0.5 : args.midtones);
   P.shadowsClipping = Number(args.shadows === undefined ? 0 : args.shadows);
   P.mode = PIMCP.enumOf(StarMask, "StarMask");
   if (args.params) PIMCP.assignParams(P, args.params);
   if (!PIMCP.quiet(P).executeOn(v, false)) PIMCP.fail("PI_PROCESS_FAILED", "StarMask failed");
   var out = null;
   ws = ImageWindow.windows;
   for (i = 0; i < ws.length; ++i) if (!before[ws[i].mainView.id]) out = ws[i];
   if (!out) PIMCP.fail("STARMASK_NO_OUTPUT", "StarMask produced no window");
   if (args.mask_id) out.mainView.id = PIMCP.win.uniqueId(args.mask_id);
   return { mask_id: out.mainView.id, source: v.id };
};

/** Range (luminance) mask as a new window from a stretched copy of the view. */
PIMCP.ops.range_mask = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var w = PIMCP.win.duplicate(v, args.mask_id || (v.id + "_range"));
   var mv = w.mainView;
   try {
      if (v.image.isColor) PIMCP.pp.exec(new ConvertToGrayscale, mv, false);
      if (args.stretch !== false && mv.image.median() < 0.08) PIMCP.stf.applyAsHT(mv, PIMCP.stf.compute(mv, "stf", true));
      var P = new RangeSelection;
      P.lowRange = Number(args.low === undefined ? 0.1 : args.low);
      P.highRange = Number(args.high === undefined ? 1.0 : args.high);
      P.fuzziness = Number(args.fuzziness === undefined ? 0.1 : args.fuzziness);
      P.smoothness = Number(args.smoothness === undefined ? 4 : args.smoothness);
      P.invert = !!args.invert;
      P.toLightness = true;
      if (args.params) PIMCP.assignParams(P, args.params);
      PIMCP.pp.exec(P, mv, false);
      w.show();
      return { mask_id: mv.id, source: v.id, low: P.lowRange, high: P.highRange, inverted: P.invert };
   } catch (e) { w.forceClose(); throw e; }
};

/** Generic mask from a PixelMath expression evaluated on the view (result as new gray window). */
PIMCP.ops.pixelmath_mask = function (args) {
   var v = PIMCP.win.view(PIMCP.req(args, "id"));
   var id = PIMCP.win.uniqueId(args.mask_id || (v.id + "_mask"));
   var P = new PixelMath;
   P.expression = PIMCP.req(args, "expression");
   P.useSingleExpression = true;
   P.createNewImage = true; P.showNewImage = true;
   P.newImageId = id;
   P.newImageColorSpace = PIMCP.enumOf(PixelMath, "Gray");
   P.rescale = !!args.rescale; P.truncate = true;
   PIMCP.pp.exec(P, v, false);
   return { mask_id: id, source: v.id };
};

PIMCP.ops.apply_mask = function (args) {
   var w = PIMCP.win.window(PIMCP.req(args, "id"));
   if (args.mask_id === null || args.mask_id === "" || args.remove) {
      w.removeMask();
      return { id: w.mainView.id, mask: null };
   }
   var mw = PIMCP.win.window(PIMCP.req(args, "mask_id"));
   if (!w.isMaskCompatible(mw)) PIMCP.fail("MASK_INCOMPATIBLE", "mask " + mw.mainView.id + " geometry does not match " + w.mainView.id);
   w.setMask(mw, !!args.inverted);
   w.maskEnabled = true;
   w.maskVisible = args.visible !== false;
   return { id: w.mainView.id, mask: mw.mainView.id, inverted: !!args.inverted };
};

PIMCP.ops.mask_info = function (args) {
   var w = PIMCP.win.window(PIMCP.req(args, "id"));
   return { id: w.mainView.id, mask: PIMCP.isNull(w.mask) ? null : w.mask.mainView.id, enabled: w.maskEnabled, inverted: w.maskInverted, visible: w.maskVisible };
};

PIMCP.ops.binarize = function (args) {
   args._op = "binarize";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new Binarize;
      var t = Number(args.threshold === undefined ? 0.5 : args.threshold);
      P.thresholdRK = t; P.thresholdG = t; P.thresholdB = t; P.isGlobal = true;
      PIMCP.pp.exec(P, v);
      return { threshold: t };
   });
};

PIMCP.ops.morphology = function (args) {
   args._op = "morph";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new MorphologicalTransformation;
      P.operator = PIMCP.enumOf(MorphologicalTransformation, args.operator || "Dilation", "operator");
      P.structureSize = Number(args.size || 5);
      P.numberOfIterations = Number(args.iterations || 1);
      P.amount = Number(args.amount === undefined ? 1 : args.amount);
      var n = P.structureSize, way = [], s = "";
      for (var i = 0; i < n * n; ++i) s += "x";
      way.push([s]);
      P.structureWayTable = way;
      PIMCP.pp.exec(P, v);
      return { operator: args.operator || "Dilation", size: n };
   });
};

PIMCP.ops.convolve = function (args) {
   args._op = "blur";
   return PIMCP.pp.destructive(args, function (v) {
      var P = new Convolution;
      P.mode = PIMCP.enumOf(Convolution, "Parametric");
      P.sigma = Number(args.sigma || 2);
      P.shape = 2; P.aspectRatio = 1;
      PIMCP.pp.exec(P, v);
      return { sigma: P.sigma };
   });
};
