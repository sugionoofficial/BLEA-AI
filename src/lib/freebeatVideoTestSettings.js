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
