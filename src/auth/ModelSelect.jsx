import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';

/**
 * Compact custom model dropdown replacing oversized native <select> popups.
 * Keeps a visually hidden synchronized native <select> so automated tests
 * and form semantics continue to work seamlessly while mobile/desktop taps
 * open a sleek, small floating popover.
 */
export function ModelSelect({
  id,
  ariaLabel,
  value,
  disabled = false,
  options = [],
  placeholder = 'Pilih model',
  onChange,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const listboxId = useId();

  const selected = options.find((opt) => opt.value === value) || options[0] || null;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSelect = (nextValue) => {
    setOpen(false);
    if (nextValue !== value) {
      onChange?.(nextValue);
    }
  };

  return (
    <div ref={rootRef} className={`generate-model-select ${open ? 'is-open' : ''}`}>
      {/* Visually hidden native select for form/DOM compatibility; never receives pointer events */}
      <select
        id={id}
        aria-hidden="true"
        tabIndex={-1}
        className="generate-select-native"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {!options.length && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.nativeLabel || opt.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="generate-model-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((cur) => !cur)}
      >
        <span className="generate-model-trigger-main">
          {selected ? (
            <>
              {selected.badge && <span className="generate-model-provider">{selected.badge}</span>}
              <span className="generate-model-name">{selected.label}</span>
            </>
          ) : (
            <span className="generate-model-name is-muted">{placeholder}</span>
          )}
        </span>
        <span className="generate-model-trigger-end">
          {selected?.meta && (
            <span className={`generate-model-cost ${selected.tone ? `is-${selected.tone}` : ''}`}>
              {selected.meta}
            </span>
          )}
          <ChevronDown size={15} className="generate-model-chevron" aria-hidden="true" />
        </span>
      </button>

      {open && options.length > 0 && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="generate-model-popover"
        >
          <div className="generate-model-popover-head">
            <span><Sparkles size={12} aria-hidden="true" /> Pilih Model</span>
            <small>{options.length} tersedia</small>
          </div>
          <div className="generate-model-list">
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`generate-model-option ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => handleSelect(opt.value)}
                >
                  <span className="generate-model-option-main">
                    <span className="generate-model-option-title">
                      {opt.badge && <span className="generate-model-provider is-sm">{opt.badge}</span>}
                      <span className="generate-model-option-name">{opt.label}</span>
                    </span>
                    {opt.sub && <span className="generate-model-option-sub">{opt.sub}</span>}
                  </span>
                  <span className="generate-model-option-end">
                    {opt.meta && (
                      <span className={`generate-model-cost ${opt.tone ? `is-${opt.tone}` : ''}`}>
                        {opt.meta}
                      </span>
                    )}
                    {isSelected && <Check size={13} className="generate-model-check" aria-hidden="true" />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
