// Probe existence of PJSR APIs the daemon relies on. ES5.
var out = jsArguments[0] + "/api-probe.json";
function has(o, k) { try { return typeof o[k]; } catch (e) { return "ERR " + e; } }
var img = new Image(16, 16, 1);
var bmp = new Bitmap(4, 4);
var r = {
   globals: { searchDirectory: typeof searchDirectory, processEvents: typeof processEvents, msleep: typeof msleep,
              gc: typeof gc, sleep: typeof sleep, FileFind: typeof FileFind, Histogram: typeof Histogram,
              ImageStatistics: typeof ImageStatistics, StarDetector: typeof StarDetector, UndoFlag_NoSwapFile: typeof UndoFlag_NoSwapFile },
   Image: { noiseMRS: has(img,"noiseMRS"), noiseKSigma: has(img,"noiseKSigma"), resample: has(img,"resample"),
            render: has(img,"render"), median: has(img,"median"), MAD: has(img,"MAD"), stdDev: has(img,"stdDev"),
            avgDev: has(img,"avgDev"), count: has(img,"count"), minimum: has(img,"minimum"), maximum: has(img,"maximum"),
            mean: has(img,"mean"), selectedChannel: has(img,"selectedChannel"), selectedRect: has(img,"selectedRect"),
            crop: has(img,"crop"), assign: has(img,"assign"), apply: has(img,"apply"), isColor: has(img,"isColor"),
            numberOfChannels: has(img,"numberOfChannels"), getPixels: has(img,"getPixels"), setPixels: has(img,"setPixels"),
            free: has(img,"free"), truncate: has(img,"truncate"), normalize: has(img,"normalize"), rescale: has(img,"rescale") },
   Bitmap: { save: has(bmp,"save"), scaledTo: has(bmp,"scaledTo"), scaled: has(bmp,"scaled"), width: has(bmp,"width"), toDataURL: has(bmp,"toDataURL"), toByteArray: has(bmp, "toByteArray") },
   View: { viewById: typeof View.viewById, stf: "?" },
   ImageWindow: { open: typeof ImageWindow.open, windows: typeof ImageWindow.windows, windowById: typeof ImageWindow.windowById, openWindows: typeof ImageWindow.openWindows },
   File: { move: typeof File.move, remove: typeof File.remove, exists: typeof File.exists, directoryExists: typeof File.directoryExists, createDirectory: typeof File.createDirectory, readTextFile: typeof File.readTextFile, writeTextFile: typeof File.writeTextFile, systemTempDirectory: typeof File.systemTempDirectory, copyFile: typeof File.copyFile, fileSize: typeof File.fileSize, extractName: typeof File.extractName },
   Console: { beginLog: typeof Console.beginLog, logText: typeof Console.logText, abortEnabled: typeof Console.abortEnabled },
   ByteArray: { toBase64: typeof ByteArray.prototype.toBase64, toString: typeof ByteArray.prototype.toString, utf8ToString: typeof ByteArray.prototype.utf8ToString },
   Enums: {}
};
var ii = ["NoRejection","MinMax","PercentileClip","SigmaClip","WinsorizedSigmaClip","AveragedSigmaClip","LinearFit","ESD","RCR","CCDClip",
          "NoNormalization","Additive","Multiplicative","AdditiveWithScaling","MultiplicativeWithScaling","LocalNormalization","AdaptiveNormalization",
          "NoRejectionNormalization","Scale","EqualizeFluxes","LocalRejectionNormalization","AdaptiveRejectionNormalization",
          "DontCare","ExposureTime","NoiseEvaluation","SignalWeight","MedianWeight","AverageWeight","KeywordWeight","PSFSignalWeight","PSFSignalPowerWeight","SNREstimate","PSFScaleSNR","Average","Median","Minimum","Maximum"];
for (var i = 0; i < ii.length; ++i) r.Enums["II." + ii[i]] = typeof ImageIntegration.prototype[ii[i]];
var dd = ["Auto","RGGB","BGGR","GBRG","GRBG","SuperPixel","Bilinear","VNG"];
for (i = 0; i < dd.length; ++i) r.Enums["Debayer." + dd[i]] = typeof Debayer.prototype[dd[i]];
var ss = ["MeasureSubframes","OutputSubframes","StarDetectionPreview","Moffat4","Gaussian","ArcSeconds","Normalized","Bits16"];
for (i = 0; i < ss.length; ++i) r.Enums["SS." + ss[i]] = typeof SubframeSelector.prototype[ss[i]];
var sa = ["RegisterMatch","Auto","Lanczos3","DDMThinPlateSpline","FitPSF_DistortionOnly","SameAsTarget","Continue","MosaicOnly"];
for (i = 0; i < sa.length; ++i) r.Enums["SA." + sa[i]] = typeof StarAlignment.prototype[sa[i]];
// view stf
try { var ws = ImageWindow.windows; r.View.openCount = ws.length; } catch (e) { r.View.err = String(e); }
try { var w = new ImageWindow(8, 8, 1, 32, true, false, "probe_tmp"); r.View.stf = typeof w.mainView.stf; r.View.beginProcess = typeof w.mainView.beginProcess; r.View.propertyValue = typeof w.mainView.propertyValue; r.View.setPropertyValue = typeof w.mainView.setPropertyValue; r.View.computeOrFetchProperty = typeof w.mainView.computeOrFetchProperty; w.forceClose(); } catch (e) { r.View.err2 = String(e); }
// noise call test
try { var n = img.noiseKSigma(); r.Image.noiseKSigmaResult = JSON.stringify(n); } catch (e) { r.Image.noiseKSigmaErr = String(e); }
try { var m = img.noiseMRS(); r.Image.noiseMRSResult = JSON.stringify(m); } catch (e) { r.Image.noiseMRSErr = String(e); }
try { var h = new Histogram(img); r.HistogramTest = { resolution: h.resolution, count0: h.count(0), total: h.totalCount, peak: typeof h.peakLevel }; } catch (e) { r.HistogramErr = String(e); }
try { var b = img.render(); var b2 = b.scaledTo(8, 8); b2.save(jsArguments[0] + "/probe.jpg", 85); r.Bitmap.saved = File.exists(jsArguments[0] + "/probe.jpg"); } catch (e) { r.Bitmap.err = String(e); }
r.PixelMath = typeof PixelMath; r.typeofBXT = typeof BlurXTerminator;
try { r.Settings = typeof Settings.read; } catch (e) {}
File.writeTextFile(out, JSON.stringify(r, null, 2));
