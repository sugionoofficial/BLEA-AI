// Default Wan diagnostic; video tests use the selected model with these fixed options.
export const FREEBEAT_VIDEO_TEST = Object.freeze({
  model_id: 182,
  generation_type: 'image',
  duration: 5,
  resolution: '480p',
});

// Legacy Gemini read-only diagnostic endpoint.
export const FREEBEAT_GEMINI_DIAGNOSTIC = Object.freeze({
  model_id: 192,
  generation_type: 'image',
  duration: 5,
  resolution: '480p',
});
