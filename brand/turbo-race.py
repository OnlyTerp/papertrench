"""PaperTrench Turbo — the drag race. Static poster + MP4 race for X.

Renders at 2x and downsamples (PIL draws aliased shapes otherwise).
  python turbo-race.py            -> turbo-race.png (1200x675)
  python turbo-race.py --video    -> turbo-race.mp4 (30fps, ~5s) via ffmpeg
"""
import math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

S = 2
W, H = 1200 * S, 675 * S
FDIR = 'C:/Windows/Fonts/'
def F(name, size):
    return ImageFont.truetype(FDIR + name, int(size * S))
BLACK = lambda s: F('seguibl.ttf', s)
BOLD = lambda s: F('segoeuib.ttf', s)
REG = lambda s: F('segoeui.ttf', s)
MONO = lambda s: F('consola.ttf', s)

WHITE = (236, 240, 247)
BODY = (196, 205, 220)
DIM = (128, 138, 156)
FAINT = (86, 95, 112)
GREEN = (0, 236, 122)
RED = (255, 84, 84)
ORANGE = (255, 158, 66)
PANEL = (17, 21, 30)
LANE = (11, 14, 21)

# -------------------------------------------------------------- helpers
def px(v): return int(round(v * S))

def text(d, xy, s, font, fill, track=0, anchor='la'):
    x, y = xy
    if not track:
        d.text((px(x), px(y)), s, font=font, fill=fill, anchor=anchor)
        return d.textlength(s, font=font) / S
    # manual letter-spacing
    cx = px(x)
    for ch in s:
        d.text((cx, px(y)), ch, font=font, fill=fill, anchor=anchor)
        cx += d.textlength(ch, font=font) + px(track)
    return (cx - px(x)) / S

def tlen(d, s, font, track=0):
    return d.textlength(s, font=font) / S + (track * (len(s) - 1) if track else 0)

def glow_layer(size, draw_fn, blur, strength=1.0):
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(layer))
    layer = layer.filter(ImageFilter.GaussianBlur(px(blur)))
    if strength != 1.0:
        a = layer.split()[3].point(lambda v: min(255, int(v * strength)))
        layer.putalpha(a)
    return layer

def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle([px(box[0]), px(box[1]), px(box[2]), px(box[3])], radius=px(r), fill=fill, outline=outline, width=px(width))

def hgrad(w, h, c0, c1):
    base = Image.new('RGBA', (w, h))
    d = ImageDraw.Draw(base)
    for i in range(w):
        t = i / max(1, w - 1)
        c = tuple(int(c0[k] + (c1[k] - c0[k]) * t) for k in range(4))
        d.line([(i, 0), (i, h)], fill=c)
    return base

def background():
    img = Image.new('RGB', (W, H), (5, 7, 12))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        c = (int(5 + 6 * t), int(7 + 8 * t), int(12 + 12 * t))
        d.line([(0, y), (W, y)], fill=c)
    # speed streak texture — faint diagonal lines sweeping right
    tex = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(tex)
    for i in range(-40, 60):
        x0 = i * px(46)
        td.line([(x0, H), (x0 + px(900), 0)], fill=(255, 255, 255, 5), width=px(1))
    img = Image.alpha_composite(img.convert('RGBA'), tex)
    # color glows
    g = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    gd.ellipse([px(-260), px(-160), px(420), px(420)], fill=(255, 70, 70, 34))
    gd.ellipse([px(760), px(300), px(1500), px(980)], fill=(0, 236, 122, 46))
    g = g.filter(ImageFilter.GaussianBlur(px(110)))
    img = Image.alpha_composite(img, g)
    # vignette
    v = Image.new('L', (W, H), 0)
    vd = ImageDraw.Draw(v)
    vd.ellipse([px(-200), px(-300), px(1400), px(1000)], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(px(220)))
    dark = Image.new('RGBA', (W, H), (0, 0, 0, 120))
    dark.putalpha(ImageChops.invert(v).point(lambda a: int(a * 0.55)))
    img = Image.alpha_composite(img, dark)
    return img

def bolt(d, x, y, s=1.0, fill=GREEN):
    pts = [(13, 0), (0, 15), (7, 15), (5, 26), (18, 10), (11, 10)]
    d.polygon([(px(x + a * s), px(y + b * s)) for a, b in pts], fill=fill)

def checker(d, x, y0, y1, cols=2, cell=11):
    rows = int((y1 - y0) / cell) + 1
    for r in range(rows):
        for c in range(cols):
            col = (236, 240, 247) if (r + c) % 2 == 0 else (28, 32, 42)
            yy0 = y0 + r * cell
            yy1 = min(y1, yy0 + cell)
            if yy1 <= yy0: continue
            d.rectangle([px(x + c * cell), px(yy0), px(x + (c + 1) * cell), px(yy1)], fill=col)

def tab_card(img, x, y, w, h, kind, spin=0.0, url='gmgn.ai/sol/token/7xKX…', title='Loading…', ghost_alpha=255):
    """A browser-tab card. kind: 'cold' | 'warm'."""
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    border = (255, 84, 84, 170) if kind == 'cold' else (0, 236, 122, 210)
    rrect(d, (x, y, x + w, y + h), 14, fill=(17, 21, 30, 250), outline=border, width=1.5)
    # favicon / status circle
    cx, cy, r = x + 30, y + h / 2, 13
    if kind == 'cold':
        d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=(70, 40, 40, 255), width=px(3))
        a0 = spin * 360
        d.arc([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], start=a0, end=a0 + 100, fill=(255, 84, 84, 255), width=px(3))
    else:
        d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=(0, 236, 122, 255))
        d.line([(px(cx - 6), px(cy + 1)), (px(cx - 1), px(cy + 6)), (px(cx + 7), px(cy - 6))], fill=(6, 12, 18, 255), width=px(3), joint='curve')
    text(d, (x + 54, y + 11), title, BOLD(15.5), WHITE if kind == 'warm' else BODY)
    text(d, (x + 54, y + 34), url, MONO(12.5), DIM)
    if kind == 'cold':
        # skeleton chart bars — nothing rendered yet
        bx = x + w - 100
        for i, hh in enumerate([10, 16, 8, 20, 13, 17]):
            d.rectangle([px(bx + i * 14), px(y + h - 16 - hh), px(bx + i * 14 + 8), px(y + h - 16)], fill=(48, 40, 46, 255))
    else:
        # a tiny live candle chart
        bx = x + w - 108
        import random
        rnd = random.Random(7)
        v = 30
        for i in range(9):
            o = v; v = max(6, min(38, v + rnd.randint(-9, 11))); c = v
            top, bot = min(o, c), max(o, c)
            col = (0, 236, 122, 255) if c >= o else (255, 84, 84, 255)
            xx = bx + i * 11
            d.line([(px(xx + 3), px(y + h - 8 - max(o, c) - 3)), (px(xx + 3), px(y + h - 8 - min(o, c) + 3))], fill=col, width=px(1))
            d.rectangle([px(xx), px(y + h - 8 - bot), px(xx + 6), px(y + h - 8 - top + 1)], fill=col)
    if ghost_alpha < 255:
        a = layer.split()[3].point(lambda p: p * ghost_alpha // 255)
        layer.putalpha(a)
    return Image.alpha_composite(img, layer)

# -------------------------------------------------------------- scene
TRACK_X0, TRACK_X1 = 300, 1044   # track lanes
FINISH_X = 1046
LANE1 = (254, 374)
LANE2 = (408, 528)
CARD_W, CARD_H = 330, 64
COLD_TOTAL = 3.10
WARM_TOTAL = 0.07

def render(t=None, hold=1.0):
    """t=None -> final static poster. t in seconds -> race frame. hold: 0..1 for end-card glow."""
    final = t is None
    if final:
        t = COLD_TOTAL
    img = background()
    d = ImageDraw.Draw(img)

    # header
    bolt(d, 56, 36, 1.05)
    text(d, (84, 36), 'PAPERTRENCH', BLACK(20), WHITE, track=2.4)
    tr = 'TURBO III'
    text(d, (1144 - tlen(d, tr, BOLD(14), 3), 40), tr, BOLD(14), DIM, track=3)

    # headline: 44x + FASTER TOKEN CLICKS
    big = BLACK(118)
    show_ratio = final or t >= COLD_TOTAL
    ratio_col = ORANGE if show_ratio else (40, 44, 54)
    if show_ratio:
        glow = glow_layer(img.size, lambda gd: gd.text((px(56), px(74)), '44×', font=big, fill=(255, 158, 66, 200)), 18, 1.2 * hold)
        img = Image.alpha_composite(img, glow); d = ImageDraw.Draw(img)
    d.text((px(56), px(74)), '44×', font=big, fill=ratio_col)
    rx = 56 + tlen(d, '44×', big) + 22
    text(d, (rx, 92), 'FASTER', BLACK(50), WHITE, track=1)
    text(d, (rx, 146), 'TOKEN CLICKS', BLACK(50), WHITE, track=1)
    text(d, (56, 216), 'Click a token → usable chart.  Same terminal, same page, same network.', REG(17.5), BODY)

    # lanes
    for (y0, y1) in (LANE1, LANE2):
        rrect(d, (TRACK_X0 - 10, y0, FINISH_X + 30, y1), 18, fill=LANE)
        # lane dashes (center line)
        for x in range(TRACK_X0 + 6, FINISH_X - 10, 34):
            d.line([(px(x), px((y0 + y1) / 2)), (px(x + 16), px((y0 + y1) / 2))], fill=(28, 33, 44), width=px(2))
    # finish line
    checker(d, FINISH_X, LANE1[0] - 10, LANE2[1] + 10)
    fl = 'USABLE CHART'
    text(d, (FINISH_X + 12 - tlen(d, fl, BOLD(11), 2.5), LANE1[0] - 30), fl, BOLD(11), DIM, track=2.5)

    # --- lane 1: vanilla
    prog = min(1.0, t / COLD_TOTAL)
    cold_x = TRACK_X0 + (FINISH_X - CARD_W - 8 - TRACK_X0) * (prog ** 1.6) * (0.0 if final else 1.0)
    # crawl: in the static poster, the cold card is still near the start at 3.1s — it's the point.
    if final: cold_x = TRACK_X0 + 84
    else: cold_x = TRACK_X0 + 84 * prog
    # dust
    dust = glow_layer(img.size, lambda gd: [gd.ellipse([px(cold_x - 40 - i * 18), px(LANE1[0] + 38 + (i % 2) * 14), px(cold_x - 6 - i * 18), px(LANE1[0] + 78 + (i % 2) * 14)], fill=(120, 110, 110, 40)) for i in range(4)], 10)
    img = Image.alpha_composite(img, dust)
    img = tab_card(img, cold_x, LANE1[0] + 28, CARD_W, CARD_H, 'cold', spin=(t * 1.4) % 1.0, title='Loading…' if prog < 1 else 'Still loading…')
    d = ImageDraw.Draw(img)

    # --- lane 2: turbo
    warm_prog = min(1.0, t / WARM_TOTAL)
    warm_end = FINISH_X - CARD_W - 8
    warm_x = TRACK_X0 + (warm_end - TRACK_X0) * (1 - (1 - warm_prog) ** 3)
    # streak behind the card
    if warm_prog > 0.15:
        sw = int(px(warm_x - TRACK_X0 + 40))
        if sw > 2:
            streak = hgrad(sw, px(36), (0, 236, 122, 0), (0, 236, 122, 150))
            streak = streak.filter(ImageFilter.GaussianBlur(px(3)))
            img.alpha_composite(streak, (px(TRACK_X0 - 30), px(LANE2[0] + 42)))
            # thin hot lines
            ld = ImageDraw.Draw(img)
            for k, (dy, a) in enumerate(((-14, 120), (0, 200), (16, 110))):
                ln = hgrad(sw, px(2), (0, 236, 122, 0), (200, 255, 230, a))
                img.alpha_composite(ln, (px(TRACK_X0 - 30), px(LANE2[0] + 60 + dy)))
    # ghost trail
    for k in range(3, 0, -1):
        gx = warm_x - k * 22 * warm_prog
        if gx > TRACK_X0 - 10:
            img = tab_card(img, gx, LANE2[0] + 28, CARD_W, CARD_H, 'warm', title='Chart ready', ghost_alpha=int(60 / k))
    img = tab_card(img, warm_x, LANE2[0] + 28, CARD_W, CARD_H, 'warm', title='Chart ready')
    d = ImageDraw.Draw(img)

    # --- leaderboard (left column)
    lx = 56
    text(d, (lx, LANE1[0] + 6), 'VANILLA CHROME', BOLD(12.5), RED, track=2.2)
    cold_t = min(t, COLD_TOTAL)
    text(d, (lx, LANE1[0] + 24), f'{cold_t:.2f}s', BLACK(52), WHITE if not final else RED)
    text(d, (lx, LANE1[0] + 90), 'still loading…' if cold_t >= COLD_TOTAL else 'loading…', REG(14.5), DIM)

    text(d, (lx, LANE2[0] + 6), 'PAPERTRENCH TURBO', BOLD(12.5), GREEN, track=2.2)
    warm_t = min(t, WARM_TOTAL)
    text(d, (lx, LANE2[0] + 24), f'{warm_t:.2f}s', BLACK(52), GREEN)
    if warm_t >= WARM_TOTAL:
        lw = text(d, (lx, LANE2[0] + 90), 'loaded', BOLD(14.5), GREEN)
        cx0, cy0 = lx + lw + 8, LANE2[0] + 100
        d.line([(px(cx0), px(cy0)), (px(cx0 + 4), px(cy0 + 4)), (px(cx0 + 12), px(cy0 - 6))], fill=GREEN, width=px(2.5), joint='curve')
    else:
        text(d, (lx, LANE2[0] + 90), 'loading…', REG(14.5), DIM)

    # footer
    d.line([(px(56), px(566)), (px(1144), px(566))], fill=(30, 35, 46), width=px(1))
    text(d, (56, 580), 'GMGN   ·   AXIOM   ·   PADRE   ·   LUTE   ·   FOMO', BOLD(15), WHITE, track=1)
    text(d, (56, 606), 'Warm viewer per terminal  ·  hover / press / trajectory pre-navigation  ·  preconnected sockets  ·  viewer pinned resident', REG(13), DIM)
    text(d, (56, 628), '*Typical cold token-page load on a heavy terminal vs warm reveal. Illustrative — the Turbo receipts card in the extension shows your own numbers.', REG(11.5), FAINT)
    u = 'papertrench.com'
    text(d, (1144 - tlen(d, u, BOLD(15)), 582), u, BOLD(15), DIM)

    return img.convert('RGB').resize((W // S, H // S), Image.LANCZOS)

OUT = os.path.dirname(os.path.abspath(__file__))

if __name__ == '__main__':
    if '--video' in sys.argv:
        fps = 30
        frames_dir = os.path.join(OUT, '_race_frames')
        os.makedirs(frames_dir, exist_ok=True)
        n = 0
        # race: 0 -> 3.1s real time, then hold 1.6s with the 44x glow pulsing
        total = COLD_TOTAL + 1.6
        while n / fps <= total:
            t = n / fps
            if t <= COLD_TOTAL:
                fr = render(t, 1.0)
            else:
                h = 0.85 + 0.15 * math.sin((t - COLD_TOTAL) * 6)
                fr = render(None, h)
            fr.save(os.path.join(frames_dir, f'f{n:04d}.png'))
            n += 1
        mp4 = os.path.join(OUT, 'turbo-race.mp4')
        subprocess.run(['ffmpeg', '-y', '-framerate', str(fps), '-i', os.path.join(frames_dir, 'f%04d.png'),
                        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', mp4], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for f in os.listdir(frames_dir): os.remove(os.path.join(frames_dir, f))
        os.rmdir(frames_dir)
        print('wrote', mp4, n, 'frames')
    else:
        out = os.path.join(OUT, 'turbo-race.png')
        render().save(out)
        print('wrote', out)
