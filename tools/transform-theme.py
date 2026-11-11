import re
import glob

# font-size scaling: small sizes up ~35-45%, mid ~25%, large ~10-15%
font_map = {
    5: 7, 6: 8, 7: 9, 8: 11, 9: 12, 10: 13, 11: 14, 12: 15, 13: 16, 14: 17,
    15: 18, 16: 19, 17: 20, 18: 21, 19: 22, 20: 23, 21: 24, 22: 25, 23: 26,
    24: 27, 25: 28, 26: 29, 27: 30, 28: 31, 29: 32, 30: 33, 31: 34, 32: 35,
    33: 36, 34: 37, 36: 38, 37: 39, 39: 41, 42: 44, 44: 46, 50: 52, 57: 60,
}

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def transform_hex(h):
    r, g, b = hex_to_rgb(h)
    v = max(r, g, b)
    m = min(r, g, b)
    sat = v - m
    # chromatic: purple (b dominant), green, amber, red — brighten 15%
    if sat > 20 or b > r + 10 or g > r + 15 or r > b + 40:
        t = 0.15
        r2 = round(r + (255 - r) * t)
        g2 = round(g + (255 - g) * t)
        b2 = round(b + (255 - b) * t)
        return f'#{r2:02x}{g2:02x}{b2:02x}'
    # grayscale
    if v < 50:
        return '#05060a'          # page/card background → near-black
    if v < 90:
        return '#1a1b22'          # dark border/block → deep gray
    if v < 130:
        return '#d8d6e0'          # muted text → light gray
    if v < 175:
        return '#f0eef7'          # secondary text → bright white
    if v < 215:
        return '#f8f7fb'          # body text → near-white
    return '#ffffff'              # headings → pure white

alpha_map = {
    0.02: 0.04, 0.025: 0.05, 0.03: 0.06, 0.04: 0.08, 0.045: 0.09, 0.05: 0.1,
    0.06: 0.12, 0.065: 0.13, 0.07: 0.14, 0.075: 0.15, 0.08: 0.16, 0.085: 0.17,
    0.09: 0.18, 0.1: 0.2, 0.12: 0.22, 0.14: 0.24, 0.16: 0.26, 0.18: 0.28,
    0.2: 0.3, 0.24: 0.32, 0.28: 0.34, 0.3: 0.36, 0.35: 0.38, 0.4: 0.42,
    0.5: 0.52, 0.6: 0.62, 0.7: 0.72, 0.8: 0.82, 0.85: 0.87, 0.9: 0.92, 0.95: 0.96,
}

def fmt_alpha(a):
    if a == int(a):
        return str(int(a))
    return f'{round(a, 2)}'

def boost_alpha(a):
    if round(a, 3) in alpha_map:
        return alpha_map[round(a, 3)]
    if a < 0.1:
        return round(a * 1.5, 2)
    if a < 0.3:
        return round(a * 1.3, 2)
    if a < 0.6:
        return round(a * 1.15, 2)
    return a

def transform_rgba(m):
    r, g, b, a = int(m.group(1)), int(m.group(2)), int(m.group(3)), float(m.group(4))
    if r == 0 and g == 0 and b == 0:
        return m.group(0)  # shadows — keep
    if r == 255 and g == 255 and b == 255:
        a2 = boost_alpha(a)
        return f'rgba(255,255,255,{fmt_alpha(a2)})'
    # colored tints (purple/green/amber/red) — brighten alpha
    if (b > r and b > g and b - r > 20) or (g > r and g > b) or (r > 180 and g < 160 and b < 160) or (r > 200 and g > 100 and b < 160):
        a2 = boost_alpha(a)
        return f'rgba({r},{g},{b},{fmt_alpha(a2)})'
    return m.group(0)

files = sorted(set(glob.glob('src/**/*.css', recursive=True)))
for path in files:
    with open(path) as f:
        content = f.read()
    content = re.sub(
        r'font-size:(\d+)px',
        lambda m: f'font-size:{font_map.get(int(m.group(1)), int(m.group(1)))}px',
        content,
    )
    content = re.sub(r'#[0-9a-fA-F]{6}', lambda m: transform_hex(m.group(0)), content)
    content = re.sub(
        r'rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)',
        transform_rgba,
        content,
    )
    with open(path, 'w') as f:
        f.write(content)
    print(f'transformed: {path}')
