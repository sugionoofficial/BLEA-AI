// Default Wan diagnostic; video tests start from these options and are then
// normalized against the model's live get_model_help before quote/submit.
// Values here are only a fallback for models whose help exposes no options.
export const FREEBEAT_VIDEO_TEST = Object.freeze({
  model_id: 182,
  generation_type: 'image', // string sesuai skema MCP: text|image|transition|reference
  duration: 5,
  resolution: '480p',
  aspect_ratio: '16:9', // kontrak web Freebeat selalu mengirim aspectRatio
});

export const FREEBEAT_VIDEO_MAX_IMAGES = 3;
export const FREEBEAT_VIDEO_INPUT_MODES = Object.freeze(['keyframe', 'omni_reference']);
export const FREEBEAT_VIDEO_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p', '768p', '2k', '4k']);
export const FREEBEAT_VIDEO_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', 'auto']);

// Safety margin added on top of the quoted credits when dispatching, so a
// provider price that rounds above the quote is still within the approved
// ceiling instead of being silently rejected with 0 accepted credits.
export const VIDEO_CREDIT_HEADROOM = Object.freeze({ ratio: 0.15, min: 10 });
export function videoHeadroom(credits) {
  const value = Math.ceil((Number(credits) || 0) * VIDEO_CREDIT_HEADROOM.ratio);
  return Math.max(VIDEO_CREDIT_HEADROOM.min, value);
}

// Legacy Gemini read-only diagnostic endpoint.
export const FREEBEAT_GEMINI_DIAGNOSTIC = Object.freeze({
  model_id: 192,
  generation_type: 'image',
  duration: 5,
  resolution: '480p',
});
