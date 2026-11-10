/** Offline LAB DSP only. No SpectrumSource, I/O or application integration. */
export { analyzePcm } from './engine.js';
export { compareSpectra, type LevelDifference, type SpectrumComparison, type SpectrumIncompatibility } from './compare.js';
export { SPECTRUM_VERSION, SPECTRUM_LIMITS, SpectrumInputError, pcmInputSchema, spectrumMeasurementSchema, spectrumOriginSchema,
  type PcmInput, type SpectrumMeasurement, type SpectrumOrigin, type SpectrumLevel, type SpectrumErrorCode } from './contracts.js';
export { measurementToFrame, spectrumFrameSchema, frameLifecycleSchema, FrameError, FRAME_VERSION, FRAME_LIMITS, SCALE_DEFINITION_ID,
  type SpectrumFrame, type FrameLifecycle, type FrameErrorCode } from './frame.js';
