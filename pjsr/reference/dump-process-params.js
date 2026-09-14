// Dumps ProcessInstance.toSource() of a default instance of every process we wrap.
// Run: PixInsight.exe -n --automation-mode -r="<repo>/pjsr/reference/dump-process-params.js,<outDir>" --force-exit
// Output: <outDir>/<ProcessId>.txt (+ index.json). ES5 only.
var outDir = (typeof jsArguments !== "undefined" && jsArguments.length > 0) ? jsArguments[0] : File.systemTempDirectory;
var ids = [
 "ImageIntegration","ImageCalibration","CosmeticCorrection","Debayer","SubframeSelector","StarAlignment",
 "LocalNormalization","DrizzleIntegration","FastIntegration","HistogramTransformation","ScreenTransferFunction",
 "Resample","IntegerResample","DynamicCrop","Crop","PixelMath","GradientCorrection","AutomaticBackgroundExtractor",
 "DynamicBackgroundExtraction","SpectrophotometricColorCalibration","PhotometricColorCalibration","ColorCalibration",
 "BackgroundNeutralization","Deconvolution","MultiscaleLinearTransform","MultiscaleMedianTransform","TGVDenoise",
 "ArcsinhStretch","MultiscaleAdaptiveStretch","CurvesTransformation","ColorSaturation","SCNR","StarMask","RangeMask",
 "RangeSelection","ChannelExtraction","ChannelCombination","LinearFit","MorphologicalTransformation","Convolution",
 "UnsharpMask","HDRMultiscaleTransform","LocalHistogramEqualization","Binarize","Invert","ConvertToRGBColor",
 "ConvertToGrayscale","Statistics","NoiseGenerator","ATrousWaveletTransform","ExponentialTransformation",
 "BlurXTerminator","NoiseXTerminator","StarXTerminator","StarNet","StarNet2","GraXpert","GeometricTransformation",
 "FastRotation","Rotation","DynamicPSF","ImageIdentifier","NewImage","CreateAlphaChannels","ExtractAlphaChannels",
 "MaskedStretch","GeneralizedHyperbolicStretch","CometAlignment","SplitCFA","MergeCFA","Superbias","ColorManagement",
 "ICCProfileTransformation","AssignICCProfile","ReadoutOptions","Annotation","Blink","CloneStamp","LRGBCombination",
 "LarsonSekanina","RGBWorkingSpace","SampleFormatConversion"
];
var index = {};
for (var i = 0; i < ids.length; ++i) {
   var id = ids[i];
   var src = null, err = null;
   try {
      var ctor = eval(id);
      if (typeof ctor === "function") {
         var p = new ctor;
         src = p.toSource();
         File.writeTextFile(outDir + "/" + id + ".txt", src);
      } else err = "not a constructor";
   } catch (e) { err = String(e); }
   index[id] = { present: !!src, error: err };
   Console.writeln(id + ": " + (src ? "ok" : ("MISSING " + err)));
}
File.writeTextFile(outDir + "/index.json", JSON.stringify(index, null, 2));
