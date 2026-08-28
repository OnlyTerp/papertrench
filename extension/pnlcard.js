/* PaperTrench — shareable P&L card.
 *
 * Renders a closed (or open) position as a single image the trader can post.
 * The layout follows the flex cards traders already know from Padre and
 * friends: the token symbol big up top, a huge ◎ SOL P&L, stat columns with
 * USD sub-lines, and room for a custom background picture behind it all.
 *
 * Two responsibilities are kept apart so the interesting part is testable
 * without a canvas:
 *   - cardModel()  — pure: turns a round/position into the exact strings,
 *                    colors and visibility flags the card shows. No DOM,
 *                    no canvas.
 *   - drawCard()   — paints that model onto a canvas (browser only).
 *
 * Everything about the layout is customizable EXCEPT one thing, and that
 * exception is the point of the product: the PAPER watermark and the
 * PaperTrench brand bar are drawn LAST, unconditionally, by drawBranding() —
 * a function that receives only the context and reads only module constants.
 * No model field, no preference, no argument combination can skip it. A
 * screenshot of a paper trade must never be passable as a real one.
 */
(() => {
  'use strict';

  const WIDTH = 1200;
  const HEIGHT = 675;           // 16:9 — posts cleanly on X without cropping
  const WATERMARK_TEXT = 'PAPER';
  const BRAND_TEXT = 'PaperTrench';
  const BRAND_TAGLINE = '· paper trading — not financial advice';
  const SITE_URL = 'papertrench.com';
  const BRAND_BAR_HEIGHT = 64;

  const COLORS = {
    bg: '#0A0D13',
    panel: 'rgba(11, 14, 20, 0.72)',
    text: '#EAEFF7',
    dim: '#8D97A9',
    faint: '#5A6273',
    amber: '#FF9D45',
    green: '#34D399',
    red: '#FF5F56',
    line: 'rgba(255, 255, 255, 0.10)',
  };

  /* Trim accents the trader can pick. The accent colors the TRIM only (left
   * rail); the P&L itself stays semantic — green for a win, red for a loss —
   * because a card that paints a loss green is a lie with a color picker. */
  const ACCENTS = {
    amber: COLORS.amber,
    blue: '#6AA9FF',
    violet: '#B786FF',
    teal: '#3ED8C3',
  };

  /* Background gallery limits, mirrored by the dashboard's IndexedDB store. */
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;   // 2 MB per image
  const MAX_UPLOADS = 10;                     // stored uploads, hard cap

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

  /**
   * Compact price formatting that stays readable across 1e-9 … 1e3.
   *
   * A shared card gets screenshotted and posted, so "3.969e-8" is the worst
   * possible rendering. Sub-cent values use subscript-zero notation, matching
   * the overlay and every Solana terminal.
   */
  function formatPrice(value) {
    const price = num(value);
    if (!(price > 0)) return '—';
    if (price >= 0.001) return String(Number(price.toPrecision(6)));

    const exponent = Math.floor(Math.log10(price));
    const leadingZeros = -exponent - 1;
    if (leadingZeros < 4) return String(Number(price.toPrecision(4)));

    const significant = price / Math.pow(10, exponent);
    const digits = String(Number(significant.toFixed(3))).replace('.', '');
    let subscript = '';
    for (const ch of String(leadingZeros)) subscript += SUBSCRIPT_DIGITS[Number(ch)];
    return '0.0' + subscript + digits;
  }

  /** Market cap for the card rail — the unit traders quote entries in. */
  function formatMarketCap(value) {
    const n = num(value);
    if (!(n > 0)) return '—';
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
  }

  function formatSol(value, dp = 3) {
    const parsed = num(value);
    if (parsed === null) return '—';
    return parsed.toLocaleString(undefined, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }

  /** "$1,234.56" (or "-$…"). Only ever fed RECORDED USD, never a guess. */
  function formatUsd(value) {
    const n = num(value);
    if (n === null) return '—';
    const abs = Math.abs(n);
    const text = abs >= 1000
      ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${n < 0 ? '-' : ''}$${text}`;
  }

  function formatHeld(ms) {
    const total = Math.max(0, Math.floor((num(ms) || 0) / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "Aug 5, 2026" — fixed format so a shared card reads the same everywhere. */
  function formatStamp(ms) {
    const d = new Date(ms);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function shortMint(mint) {
    const text = typeof mint === 'string' ? mint : '';
    return text.length > 10 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
  }

  /**
   * Honest USD total for one side of a round.
   *
   * Every fill on the side must have recorded BOTH a native and a USD price
   * at fill time — that pair is the real SOL/USD rate of that exact moment.
   * If even one fill predates the USD tick, the answer is null (the card
   * renders an em-dash), never a partial sum and never a conversion at some
   * assumed later rate. Mirrors the engine's weightedUsd discipline.
   */
  function usdTotal(fills, side, solField) {
    const list = (Array.isArray(fills) ? fills : []).filter((f) => f && f.side === side);
    if (!list.length) return null;
    let total = 0;
    for (const fill of list) {
      const usd = num(fill.priceUsd);
      const native = num(fill.priceNative);
      const sol = num(fill[solField]);
      if (!(usd > 0) || !(native > 0) || sol === null) return null;
      total += sol * (usd / native);
    }
    return total;
  }

  /**
   * Sum of every fill's simulated fee, buys and sells alike — the cost of
   * the round trip printed on the card. Zero when no fill recorded a fee
   * (pre-fee rounds stay silent), null-safe against junk shapes.
   */
  function feesTotal(fills) {
    const list = (Array.isArray(fills) ? fills : []).filter((f) => f && num(f.feeSol) > 0);
    if (!list.length) return 0;
    let total = 0;
    for (const fill of list) total += num(fill.feeSol);
    return total;
  }

  /**
   * Gallery admission for user-uploaded backgrounds.
   *
   * Pure and side-effect free so the refusals can be tested directly. A full
   * gallery REFUSES the new image with a visible reason — nothing is ever
   * silently evicted; the user decides what goes.
   */
  function admitUpload(file, storedCount) {
    const size = file ? Number(file.size) : NaN;
    const type = file ? String(file.type || '') : '';
    const count = Number(storedCount) || 0;
    if (!file || !Number.isFinite(size) || size <= 0) {
      return { ok: false, reason: 'That file could not be read.' };
    }
    if (type && !/^image\//.test(type)) {
      return { ok: false, reason: 'Card backgrounds must be images.' };
    }
    if (size > MAX_UPLOAD_BYTES) {
      const mb = (size / (1024 * 1024)).toFixed(1);
      return { ok: false, reason: `That image is ${mb} MB — the limit is 2 MB.` };
    }
    if (count >= MAX_UPLOADS) {
      return {
        ok: false,
        reason: `The gallery is full (${MAX_UPLOADS}/${MAX_UPLOADS}) — delete a background to add another. Nothing is evicted for you.`,
      };
    }
    return { ok: true, reason: '' };
  }

  /**
   * Card source for one CLOSED round. This is THE derivation — the dashboard
   * composer and the in-page overlay composer both call it, so a shared card
   * can never show different numbers depending on where it was opened.
   * Entry/exit are quantity-weighted over the round's actual fills; USD
   * totals exist only when every fill on that side recorded a USD price at
   * fill time (usdTotal), else null and the card shows an em-dash.
   */
  function roundCardSource(round, journal) {
    if (!round || typeof round !== 'object') return null;
    const trades = (Array.isArray(journal) ? journal : [])
      .filter((t) => t && (round.tradeIds || []).includes(t.id));
    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');
    const weighted = (list, field) => {
      const qty = list.reduce((sum, t) => sum + (num(t.qty) || 0), 0);
      if (!(qty > 0)) return null;
      const total = list.reduce(
        (sum, t) => sum + (num(t.qty) || 0) * (num(t[field]) || 0), 0
      );
      return total > 0 ? total / qty : null;
    };
    // D-09: an mcap average is only honest if EVERY fill on the side
    // recorded one. Fresh-launch fills often pre-date the mcap tick and
    // carry mcap: null; the plain weighted() above counts their qty in the
    // denominator but 0 in the numerator, understating the entry/exit mcap
    // on the card — the exact shape usdTotal/weightedUsd guard against
    // elsewhere. All-or-nothing: incomplete set → null → the card falls
    // back to the price line, never a partial average that pretends to be
    // the whole story.
    const weightedMcap = (list) => {
      // Only fills that actually contribute qty to the average get a vote;
      // a zero-qty row carries no information either way.
      const real = list.filter((t) => num(t.qty) > 0);
      const ok = real.length > 0 && real.every((t) => num(t.mcap) > 0);
      return ok ? weighted(real, 'mcap') : null;
    };
    return {
      ...round,
      entryPrice: weighted(buys, 'priceNative'),
      exitPrice: weighted(sells, 'priceNative'),
      entryMcap: weightedMcap(buys),
      exitMcap: weightedMcap(sells),
      investedUsd: usdTotal(trades, 'buy', 'solGross'),
      returnedUsd: usdTotal(trades, 'sell', 'solNet'),
      // The trainer that tells the truth: every fill's simulated fee is
      // summed onto the card so "why is my +3x only +2.4x" has an answer
      // printed on the artifact itself. Old rounds without fee data stay
      // fee-silent rather than fabricating a number.
      feesSol: feesTotal(trades),
    };
  }

  /**
   * Card source for an OPEN position — the "still holding" card. The live
   * value stands in for proceeds (cardModel labels the column POSITION when
   * open). The P&L figures are engine-derived and passed in by the caller so
   * this module stays dependency-free; USD only where the mark genuinely
   * recorded a USD price — never a conversion at an assumed rate.
   * `derived` = { pnlSol, pnlPct, avgBuyNative }.
   */
  function positionCardSource(pos, journal, derived, now) {
    if (!pos || typeof pos !== 'object') return null;
    const d = derived || {};
    const qty = num(pos.qty) || 0;
    const lastNative = num(pos.lastPriceNative) || 0;
    const fills = (Array.isArray(journal) ? journal : [])
      .filter((t) => t && t.mint === pos.mint && t.ts >= pos.openedAt);
    const lastUsd = Number(pos.lastPriceUsd);
    const avgBuy = Number(d.avgBuyNative);
    return {
      mint: pos.mint,
      symbol: pos.symbol,
      site: pos.site,
      openedAt: pos.openedAt,
      heldMs: (Number(now) || 0) - pos.openedAt,
      investedSol: pos.investedSol,
      returnedSol: qty * lastNative,
      pnlSol: d.pnlSol,
      pnlPct: d.pnlPct,
      entryPrice: avgBuy > 0 ? avgBuy : null,
      lastPriceNative: lastNative,
      entryMcap: null,
      exitMcap: null,
      investedUsd: usdTotal(fills, 'buy', 'solGross'),
      returnedUsd: Number.isFinite(lastUsd) && lastUsd > 0 ? qty * lastUsd : null,
      feesSol: feesTotal(fills),
    };
  }

  /* Built-in card backgrounds — drawn procedurally in the brand palette, so
   * they cost zero assets and work identically on the 1200×675 card and the
   * little gallery thumbnails. All of them are dark by construction; the
   * numbers stay legible without a scrim. */
  const BACKGROUNDS = [
    { id: 'void', name: 'Void', paint(ctx, w, h) {
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, w, h);
    } },
    { id: 'ember', name: 'Ember', paint(ctx, w, h) {
      ctx.fillStyle = '#0D0A07';
      ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w * 0.2, h * 1.05, 0, w * 0.2, h * 1.05, Math.max(w, h) * 0.9);
      glow.addColorStop(0, 'rgba(255, 127, 39, 0.36)');
      glow.addColorStop(0.45, 'rgba(255, 157, 69, 0.12)');
      glow.addColorStop(1, 'rgba(255, 157, 69, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      const top = ctx.createRadialGradient(w * 0.9, -h * 0.1, 0, w * 0.9, -h * 0.1, Math.max(w, h) * 0.6);
      top.addColorStop(0, 'rgba(255, 94, 30, 0.10)');
      top.addColorStop(1, 'rgba(255, 94, 30, 0)');
      ctx.fillStyle = top;
      ctx.fillRect(0, 0, w, h);
    } },
    { id: 'deep', name: 'Deep', paint(ctx, w, h) {
      const sea = ctx.createLinearGradient(0, 0, w, h);
      sea.addColorStop(0, '#08111F');
      sea.addColorStop(0.55, '#0B1A33');
      sea.addColorStop(1, '#050A14');
      ctx.fillStyle = sea;
      ctx.fillRect(0, 0, w, h);
      const beam = ctx.createRadialGradient(w * 0.75, h * 0.2, 0, w * 0.75, h * 0.2, Math.max(w, h) * 0.7);
      beam.addColorStop(0, 'rgba(106, 169, 255, 0.14)');
      beam.addColorStop(1, 'rgba(106, 169, 255, 0)');
      ctx.fillStyle = beam;
      ctx.fillRect(0, 0, w, h);
    } },
    { id: 'dusk', name: 'Dusk', paint(ctx, w, h) {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#170D2B');
      sky.addColorStop(0.6, '#221040');
      sky.addColorStop(1, '#0B0714');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      const halo = ctx.createRadialGradient(w * 0.5, h * 0.85, 0, w * 0.5, h * 0.85, Math.max(w, h) * 0.55);
      halo.addColorStop(0, 'rgba(183, 134, 255, 0.20)');
      halo.addColorStop(1, 'rgba(183, 134, 255, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);
    } },
    { id: 'grid', name: 'Grid', paint(ctx, w, h) {
      ctx.fillStyle = '#090C12';
      ctx.fillRect(0, 0, w, h);
      const step = Math.max(24, Math.round(w / 20));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
      for (let y = step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
      ctx.stroke();
      const fade = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      fade.addColorStop(0, 'rgba(9, 12, 18, 0)');
      fade.addColorStop(1, 'rgba(9, 12, 18, 0.9)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
    } },
  ];

  /** Paint one built-in background by id. False when the id is unknown. */
  function paintBackground(ctx, id, w, h) {
    const bg = BACKGROUNDS.find((b) => b.id === id);
    if (!ctx || !bg) return false;
    ctx.save();
    bg.paint(ctx, w, h);
    ctx.restore();
    return true;
  }

  /**
   * Turn a round trip (or an open position) into everything the card renders.
   *
   * Pure and canvas-free, so the numbers on a shared card can be asserted
   * directly. Returns null when there is nothing meaningful to show, rather
   * than rendering a card full of dashes.
   *
   * `opts.prefs` carries the customization flags (showSymbol, showInvested,
   * showReturned, showPercent, showUsd, showDate, showAfter, accent,
   * background). An ABSENT flag means shown — old settings blobs keep meaning
   * "everything on". There is deliberately no flag for the watermark or the
   * brand bar; drawCard ignores the model entirely for those.
   */
  function cardModel(source, opts) {
    if (!source || typeof source !== 'object') return null;
    const options = opts || {};
    const prefs = options.prefs || {};

    const invested = num(source.investedSol);
    const returned = num(source.returnedSol);
    const open = !(num(source.closedAt) > 0);

    // An open position has no `returnedSol`; its live value stands in.
    const pnlSol = num(source.pnlSol);
    const basis = invested !== null && invested > 0 ? invested : null;
    if (pnlSol === null || basis === null) return null;

    const pnlPct = num(source.pnlPct) !== null ? num(source.pnlPct) : (pnlSol / basis) * 100;
    const win = pnlSol >= 0;
    // The cost of the round trip, when the fills recorded it. Printed on
    // the card so the multiple and the fees are never a mystery apart.
    const fees = num(source.feesSol) || 0;
    // Traders read multiples, not percentages, on a flex card.
    const multiple = (basis + pnlSol) / basis;

    // USD figures are only ever RECORDED, never derived here from an assumed
    // rate: the caller passes totals built from fills that all carried a USD
    // price at fill time (usdTotal), or nothing at all. Missing renders as an
    // em-dash — an honest gap, not a fabricated conversion. Number.isFinite
    // (no coercion) matters: Number(null) is 0, and an absent total must not
    // become a fabricated "$0.00".
    const investedUsd = Number.isFinite(source.investedUsd) && source.investedUsd > 0
      ? Number(source.investedUsd)
      : null;
    const returnedUsd = Number.isFinite(source.returnedUsd) && source.returnedUsd >= 0
      ? Number(source.returnedUsd)
      : null;
    const pnlUsd = investedUsd !== null && returnedUsd !== null ? returnedUsd - investedUsd : null;

    // The After: observed post-exit extremes only — a watch that saw nothing
    // wrote nothing, and this line simply repeats what was recorded.
    const after = source.afterExit && typeof source.afterExit === 'object' ? source.afterExit : null;
    let afterText = '';
    let afterColor = COLORS.dim;
    if (after && num(after.samples) > 0) {
      const up = num(after.maxPct);
      const down = num(after.minPct);
      const dominant = up === null ? down : (down === null ? up : (Math.abs(up) >= Math.abs(down) ? up : down));
      if (dominant !== null) {
        const missed = dominant >= 0;
        afterColor = missed ? COLORS.amber : COLORS.green;
        afterText = `${missed ? '+' : ''}${dominant.toFixed(0)}% after exit — ${missed ? 'left on the table' : 'dodged'}`;
      }
    }

    const stampAt = num(source.closedAt) > 0 ? num(source.closedAt) : num(source.openedAt);
    const on = (flag) => flag !== false;
    const requestedBg = options.background || prefs.background || null;

    // Trench rank / process grade / badges (GAMIFY.md UI pass): derived by
    // the COMPOSER via PTGamify from the same state every surface reads, and
    // passed in — never computed here, so both composers stay in lockstep.
    const trench = options.trench && typeof options.trench === 'object' ? options.trench : null;
    const gradeLetter = trench && /^[SABCDF]$/.test(String(trench.gradeLetter || '')) ? trench.gradeLetter : '';
    const badgeLabels = trench && Array.isArray(trench.badges)
      ? trench.badges.filter((b) => typeof b === 'string' && b.trim()).slice(0, 4)
      : [];

    return {
      symbol: String(source.symbol || shortMint(source.mint) || '—'),
      mint: String(source.mint || ''),
      mintShort: shortMint(source.mint),
      site: String(source.site || ''),
      open,
      win,
      // Display strings — exactly what gets painted.
      multipleText: `${multiple.toFixed(multiple >= 10 ? 1 : 2)}x`,
      pnlPctText: `${win ? '+' : ''}${pnlPct.toFixed(1)}%`,
      pnlSolText: `${win ? '+' : ''}${formatSol(pnlSol)} SOL`,
      pnlSolHeroText: `${win ? '+' : ''}${formatSol(pnlSol, Math.abs(pnlSol) >= 100 ? 1 : 2)}`,
      investedText: `${formatSol(invested)} SOL`,
      returnedText: returned === null ? '—' : `${formatSol(returned)} SOL`,
      investedUsdText: investedUsd !== null ? `(${formatUsd(investedUsd)})` : '—',
      returnedUsdText: returnedUsd !== null ? `(${formatUsd(returnedUsd)})` : '—',
      pnlUsdText: pnlUsd !== null ? `(${pnlUsd >= 0 ? '+' : ''}${formatUsd(pnlUsd)})` : '—',
      // Entry and exit read as market caps when they are known, because that
      // is how a trade gets described: "in at 240K, out at 900K".
      entryText: num(source.entryMcap) > 0
        ? formatMarketCap(source.entryMcap)
        : formatPrice(source.entryPrice ?? source.avgEntry),
      exitText: num(source.exitMcap) > 0
        ? formatMarketCap(source.exitMcap)
        : formatPrice(source.exitPrice ?? source.lastPriceNative),
      heldText: formatHeld(source.heldMs),
      feesText: fees > 0 ? `incl ${formatSol(fees)} SOL fees` : '',
      dateText: stampAt > 0 ? formatStamp(stampAt) : '',
      afterText,
      afterColor,
      // Process grade: PAPER PROCESS wording keeps it unmistakable that the
      // grade judges process on a paper trade, and a lucky win says so.
      gradeText: gradeLetter ? `${gradeLetter} PROCESS${trench.luckyWin ? ' · LUCKY' : ''}` : '',
      gradeColor: { S: '#B786FF', A: COLORS.green, B: '#6AA9FF', C: COLORS.amber, D: COLORS.red, F: COLORS.red }[gradeLetter] || COLORS.dim,
      rankText: trench && trench.rankName ? String(trench.rankName).toUpperCase() : '',
      badgesText: badgeLabels.join(' · ').toUpperCase(),
      // Semantic verdict color — never overridden by the accent pick.
      accent: win ? COLORS.green : COLORS.red,
      // Cosmetic trim only.
      trim: ACCENTS[prefs.accent] || COLORS.amber,
      statusText: open ? 'OPEN POSITION' : 'CLOSED',
      show: {
        symbol: on(prefs.showSymbol),
        invested: on(prefs.showInvested),
        returned: on(prefs.showReturned),
        percent: on(prefs.showPercent),
        usd: on(prefs.showUsd),
        date: on(prefs.showDate),
        after: on(prefs.showAfter),
        trench: on(prefs.showTrench),
      },
      // Never optional: a shared paper trade must be labelled as one. These
      // fields exist for callers to read; drawBranding does not consult them.
      watermark: WATERMARK_TEXT,
      brand: BRAND_TEXT,
      handle: options.handle ? `@${String(options.handle).replace(/^@+/, '')}` : '',
      background: BACKGROUNDS.some((b) => b.id === requestedBg) ? requestedBg : null,
    };
  }

  /** Cover-fit a source image into the card, preserving aspect ratio. */
  function coverRect(sourceWidth, sourceHeight, boxWidth, boxHeight) {
    const sw = num(sourceWidth) || 1;
    const sh = num(sourceHeight) || 1;
    const scale = Math.max(boxWidth / sw, boxHeight / sh);
    const width = sw * scale;
    const height = sh * scale;
    return {
      x: (boxWidth - width) / 2,
      y: (boxHeight - height) / 2,
      width,
      height,
    };
  }

  /**
   * Paint the card.
   *
   * `media` is an optional already-loaded HTMLImageElement / HTMLVideoElement /
   * ImageBitmap used as the background (a user upload). A GIF passed as an
   * <img> paints its currently-displayed frame. When no media is given, the
   * model's built-in background id (if any) is painted instead.
   *
   * Draw order matters: every customizable element paints first, and
   * drawBranding() paints LAST so the PAPER watermark and brand bar sit on
   * top of whatever the trader chose to show or hide.
   */
  function drawCard(ctx, model, media) {
    if (!ctx || !model) return false;
    // Absent flags mean "shown" — hand-built models without `show` keep the
    // full layout.
    const show = model.show || {};
    const trim = model.trim || COLORS.amber;

    ctx.save();
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // 1. Ground.
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. Background: the user's picture, cover-fit and scrimmed so text stays
    // legible — or one of the built-in procedural backdrops.
    if (media) {
      const sw = media.naturalWidth || media.videoWidth || media.width;
      const sh = media.naturalHeight || media.videoHeight || media.height;
      const box = coverRect(sw, sh, WIDTH, HEIGHT);
      try {
        ctx.drawImage(media, box.x, box.y, box.width, box.height);
      } catch (_) { /* tainted or not ready: fall through to the plain ground */ }

      // Scrim: without it a bright picture makes every number unreadable.
      const scrim = ctx.createLinearGradient(0, 0, 0, HEIGHT);
      scrim.addColorStop(0, 'rgba(10, 13, 19, 0.72)');
      scrim.addColorStop(0.55, 'rgba(10, 13, 19, 0.82)');
      scrim.addColorStop(1, 'rgba(10, 13, 19, 0.94)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    } else if (model.background) {
      paintBackground(ctx, model.background, WIDTH, HEIGHT);
    }

    // 3. Trim rail down the left edge — the accent pick, never the verdict.
    ctx.fillStyle = trim;
    ctx.fillRect(0, 0, 8, HEIGHT);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // 4. Header: the token, big, Padre-style — plus the multiple chip.
    let headerX = 64;
    if (show.symbol !== false) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '800 54px Inter, ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(model.symbol, headerX, 104);
      headerX += ctx.measureText(model.symbol).width + 22;

      ctx.fillStyle = COLORS.faint;
      ctx.font = '500 19px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(model.mintShort, 64, 136);
    }
    if (show.percent !== false) {
      ctx.fillStyle = model.accent;
      ctx.font = '800 30px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(model.multipleText, headerX, 104);
    }

    // 5. Top-right: status, then date, then the trader's handle.
    ctx.textAlign = 'right';
    ctx.fillStyle = model.accent;
    ctx.font = '800 16px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.fillText(model.statusText, WIDTH - 64, 92);
    let rightY = 120;
    if (show.date !== false && model.dateText) {
      ctx.fillStyle = COLORS.faint;
      ctx.font = '500 16px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(model.dateText, WIDTH - 64, rightY);
      rightY += 28;
    }
    if (model.handle) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = '700 18px Inter, ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(model.handle, WIDTH - 64, rightY);
      rightY += 28;
    }
    // 5b. Process grade, continuing the top-right stack (GAMIFY.md): the
    // grade judges PROCESS, so it rides the meta stack, never the P&L hero.
    if (show.trench !== false && model.gradeText) {
      ctx.fillStyle = model.gradeColor || COLORS.dim;
      ctx.font = '800 18px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(model.gradeText, WIDTH - 64, rightY);
    }
    ctx.textAlign = 'left';

    // 6. The hero: ◎ and the SOL P&L, huge, in the semantic verdict color.
    ctx.fillStyle = model.accent;
    ctx.font = '700 88px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('◎', 64, 316);
    const glyphWidth = ctx.measureText('◎').width;
    ctx.font = '900 148px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(model.pnlSolHeroText, 64 + glyphWidth + 24, 326);

    // 7. The After — observed post-exit truth, straight off the round record.
    if (show.after !== false && model.afterText) {
      ctx.fillStyle = model.afterColor || COLORS.dim;
      ctx.font = '700 24px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(model.afterText, 64, 386);
    }

    // 8. Stat columns: Invested / Returned / P&L %, USD sub-lines beneath.
    // Hidden columns reflow the remainder rather than leaving holes.
    const columns = [];
    if (show.invested !== false) columns.push(['INVESTED', model.investedText, model.investedUsdText, COLORS.text]);
    // An open position's middle column is its LIVE value, not proceeds.
    if (show.returned !== false) columns.push([model.open ? 'POSITION' : 'RETURNED', model.returnedText, model.returnedUsdText, COLORS.text]);
    if (show.percent !== false) columns.push(['P&L %', model.pnlPctText, model.pnlUsdText, model.accent]);
    if (columns.length) {
      const railLeft = 64;
      const railRight = WIDTH - 64;
      const columnWidth = (railRight - railLeft) / columns.length;
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(railLeft, 436);
      ctx.lineTo(railRight, 436);
      ctx.stroke();
      columns.forEach(([label, value, usdSub, color], index) => {
        const x = railLeft + columnWidth * index;
        ctx.fillStyle = COLORS.faint;
        ctx.font = '700 15px ui-monospace, "JetBrains Mono", Menlo, monospace';
        ctx.fillText(label, x, 470);
        ctx.fillStyle = color;
        ctx.font = '700 34px ui-monospace, "JetBrains Mono", Menlo, monospace';
        ctx.fillText(value, x, 510);
        if (show.usd !== false) {
          // Parenthesised USD when the round recorded it; a plain em-dash
          // when it did not. Never a conversion at today's rate.
          ctx.fillStyle = COLORS.dim;
          ctx.font = '500 19px ui-monospace, "JetBrains Mono", Menlo, monospace';
          ctx.fillText(usdSub, x, 542);
        }
      });
    }

    // 9. The journey line: entry → exit → hold, when known.
    const journey = [];
    if (model.entryText && model.entryText !== '—') journey.push('ENTRY ' + model.entryText);
    if (!model.open && model.exitText && model.exitText !== '—') journey.push('EXIT ' + model.exitText);
    if (model.heldText && model.heldText !== '0s') journey.push('HELD ' + model.heldText);
    if (model.feesText) journey.push(model.feesText.toUpperCase());
    let journeyRightEdge = 64;
    if (journey.length) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = '500 19px ui-monospace, "JetBrains Mono", Menlo, monospace';
      const journeyText = journey.join('   ·   ');
      ctx.fillText(journeyText, 64, 584);
      journeyRightEdge = 64 + ctx.measureText(journeyText).width;
    }

    // 9b. Trench rank + badges, right-aligned on the journey row — but only
    // when they FIT beside it. Collisions degrade honestly: drop badges
    // first, then the rank, never overprint the journey.
    if (show.trench !== false && (model.rankText || model.badgesText)) {
      ctx.font = '700 17px ui-monospace, "JetBrains Mono", Menlo, monospace';
      const roomFor = (text) => text
        && ctx.measureText(text).width <= (WIDTH - 64) - journeyRightEdge - 40;
      const combined = model.rankText && model.badgesText
        ? `${model.rankText}   ·   ${model.badgesText}` : '';
      const line = [combined, model.rankText, model.badgesText].find(roomFor) || '';
      if (line) {
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.amber;
        ctx.fillText(line, WIDTH - 64, 584);
        ctx.textAlign = 'left';
      }
    }

    // 10. NON-NEGOTIABLE, LAST, UNCONDITIONAL. drawBranding takes only the
    // context — there is no flag, pref, or model field it could read, so no
    // input combination produces a card without the PAPER watermark and the
    // PaperTrench brand bar.
    drawBranding(ctx);

    ctx.restore();
    return true;
  }

  /**
   * The watermark doctrine, enforced by construction.
   *
   * Called unconditionally as drawCard's final step, and it receives ONLY
   * the context: no model, no prefs, no flags — everything it paints comes
   * from module constants. If you are editing this file to make the PAPER
   * watermark or the PaperTrench mark removable: that is the one change this
   * project will not take. Honest numbers are a safety property.
   */
  function drawBranding(ctx) {
    // Diagonal PAPER watermark, over everything drawn before it.
    ctx.save();
    ctx.translate(WIDTH / 2, HEIGHT / 2);
    ctx.rotate(-20 * Math.PI / 180);
    ctx.font = '900 210px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 157, 69, 0.18)';
    ctx.fillStyle = 'rgba(255, 157, 69, 0.07)';
    ctx.fillText(WATERMARK_TEXT, 0, 0);
    ctx.strokeText(WATERMARK_TEXT, 0, 0);
    ctx.restore();

    // Brand bar across the bottom: mark, name, disclaimer, site.
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(6, 8, 12, 0.92)';
    ctx.fillRect(0, HEIGHT - BRAND_BAR_HEIGHT, WIDTH, BRAND_BAR_HEIGHT);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEIGHT - BRAND_BAR_HEIGHT + 0.5);
    ctx.lineTo(WIDTH, HEIGHT - BRAND_BAR_HEIGHT + 0.5);
    ctx.stroke();

    const baseline = HEIGHT - 25;
    ctx.fillStyle = COLORS.amber;
    roundRect(ctx, 64, HEIGHT - 45, 26, 26, 7);
    ctx.fill();
    ctx.fillStyle = '#2A1400';
    ctx.font = '900 16px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('P', 77, baseline);

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = '800 19px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(BRAND_TEXT, 102, baseline);
    const brandWidth = ctx.measureText(BRAND_TEXT).width;
    ctx.fillStyle = COLORS.dim;
    ctx.font = '500 15px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(BRAND_TAGLINE, 102 + brandWidth + 9, baseline);

    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.amber;
    ctx.font = '600 15px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.fillText(SITE_URL, WIDTH - 64, baseline);
    ctx.restore();
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  /* ================= Trench Season share card (ROADMAP item 6) =================
   *
   * Wordle's grid beat its gameplay: the card must NOT spoil (no final PnL),
   * must be legible in 2 seconds, must provoke "what happened?". The season
   * card is spoiler-free BY CONSTRUCTION: its source has no PnL fields at
   * all — gates, rounds, journal coverage, grades, streak, rank. What the
   * trader did with money is their story to tell in the reply. */

  /** Season source: plain numbers, zero PnL. Derived by the caller from
   * PTGamify (gameSession + streakLadder + rank) — this function only
   * shapes and validates; it computes nothing. */
  function seasonCardSource(session, trench) {
    if (!session || typeof session !== 'object') return null;
    if (session.id !== 'season' && session.id !== 'survival') return null;
    const s = session;
    const t = trench && typeof trench === 'object' ? trench : {};
    return {
      id: s.id === 'survival' ? 'survival' : 'season',
      status: ['live', 'won', 'missed', 'busted'].includes(s.status) ? s.status : 'live',
      rounds: num(s.rounds) || 0,
      daysLeft: Math.max(0, Math.ceil(((s.startedAt + 7 * 86400000) - (num(s.endedAt) || Date.now())) / 86400000)),
      startedAt: num(s.startedAt) || 0,
      coverage: num(t.coverage) !== null ? num(t.coverage) : null,
      avgGrade: num(t.avgGrade) !== null ? num(t.avgGrade) : null,
      streak: num(t.streak) !== null ? num(t.streak) : 0,
      streakTier: t.streakTier && typeof t.streakTier.name === 'string' ? t.streakTier.name : null,
      rankName: t.rankName && typeof t.rankName === 'string' ? t.rankName : null,
      belts: num(t.belts) !== null ? num(t.belts) : 0,
      elimination: typeof s.elimination === 'string' ? s.elimination : null,
      gates: s.gates && typeof s.gates === 'object' ? {
        played: Boolean(s.gates.played),
        journaled: Boolean(s.gates.journaled),
        graded: Boolean(s.gates.graded),
      } : null,
    };
  }

  /** Season model: display strings only, spoiler-free. */
  function seasonCardModel(source, opts) {
    if (!source || typeof source !== 'object') return null;
    const options = opts || {};
    const prefs = options.prefs || {};
    const on = (flag) => flag !== false;
    const survival = source.id === 'survival';
    const statusText = {
      live: survival ? 'SURVIVAL — LIVE' : 'SEASON — LIVE',
      won: 'BELT WON',
      missed: 'WINDOW CLOSED',
      busted: 'BUSTED',
    }[source.status] || 'SEASON';
    const statusColor = {
      live: COLORS.amber,
      won: COLORS.green,
      missed: COLORS.amber,
      busted: COLORS.red,
    }[source.status] || COLORS.dim;
    // Gate glyphs: one line, three gates, done = filled dot. The 2-second
    // read: count the dots. The card never says which gate is missing by
    // name — "what's missing?" is the reply bait.
    const gates = source.gates || {};
    const gateDots = [
      gates.played,
      gates.journaled,
      gates.graded,
    ].map((d) => (d ? '●' : '○'));
    return {
      kind: 'season',
      survival,
      statusText,
      statusColor,
      roundsText: `${source.rounds} rounds`,
      coverageText: source.coverage !== null ? `${Math.round(source.coverage * 100)}% journaled` : '—',
      avgGradeText: source.avgGrade !== null ? source.avgGrade.toFixed(1) : '—',
      streakText: source.streak > 0 ? `${source.streak}-round streak${source.streakTier ? ` · ${source.streakTier}` : ''}` : 'no streak',
      rankText: source.rankName ? String(source.rankName).toUpperCase() : '',
      beltsText: source.belts > 0 ? `${source.belts} belt${source.belts === 1 ? '' : 's'}` : '',
      gateDots,
      dateText: source.startedAt > 0 ? formatStamp(source.startedAt) : '',
      daysLeftText: source.status === 'live' ? `${source.daysLeft}d left` : '',
      eliminationText: source.elimination || '',
      handle: options.handle ? `@${String(options.handle).replace(/^@+/, '')}` : '',
      trim: ACCENTS[prefs.accent] || COLORS.amber,
      show: {
        rank: on(prefs.showTrench),
        streak: on(prefs.showTrench),
      },
    };
  }

  /** Season painter: big status, gate dots, discipline lines. */
  function drawSeasonCard(ctx, model) {
    if (!ctx || !model || model.kind !== 'season') return;
    ctx.save();
    paintBackground(ctx, model.background || 'void', WIDTH, HEIGHT);
    // Brand bar (same geometry as the round card — drawBranding is shared)
    drawBrandingSafe(ctx, model);
    const cx = 64;
    let y = 150;
    // Headline: status word, huge
    ctx.font = '800 64px Inter, system-ui, sans-serif';
    ctx.fillStyle = model.statusColor;
    ctx.fillText(model.statusText, cx, y);
    y += 44;
    // Gate dots row
    ctx.font = '700 30px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`${model.gateDots.join(' ')}`, cx, y);
    y += 46;
    // Discipline lines
    ctx.font = '600 24px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${model.roundsText} · ${model.coverageText} · avg ${model.avgGradeText}`, cx, y);
    y += 34;
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(model.streakText, cx, y);
    if (model.rankText && model.show.rank) {
      y += 30;
      ctx.fillText(model.rankText, cx, y);
    }
    if (model.daysLeftText) {
      y += 30;
      ctx.fillText(model.daysLeftText, cx, y);
    }
    if (model.eliminationText && model.survival) {
      y += 30;
      ctx.fillStyle = COLORS.red;
      ctx.fillText(model.eliminationText, cx, y);
    }
    // Handle top-right in the brand area
    if (model.handle) {
      ctx.font = '600 16px Inter, system-ui, sans-serif';
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(model.handle, WIDTH - 200, 40);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  /** Spark share-card model: process-grade story ONLY, never a PnL figure.
   * Mirrors PTSpark.sparkCardModel but lives here so the painter has one
   * source of truth for card geometry. */
  function sparkCardModel(verdict, day, opts) {
    if (!verdict || typeof verdict !== 'object') return null;
    const grade = String(verdict.grade || '').toUpperCase();
    const style = {
      S: { color: '#7C3AED', label: 'S — flawless read' },
      A: { color: '#34D399', label: 'A — strong read' },
      B: { color: '#6AA9FF', label: 'B — solid' },
      C: { color: '#FF9D45', label: 'C — sloppy' },
      D: { color: '#FF5F56', label: 'D — broke the rules' },
      F: { color: '#FF2D2D', label: 'F — no discipline' },
    }[grade];
    if (!style) return null;
    const axes = Array.isArray(verdict.axes) ? verdict.axes : [];
    const axisLine = axes
      .map((a) => `${a.label}: ${({ green: 'good', yellow: 'okay', red: 'bad' })[a.tone] || 'good'}`)
      .join(' · ');
    const options = opts || {};
    return {
      kind: 'spark',
      grade,
      gradeColor: style.color,
      gradeLabel: style.label,
      axisLine,
      day: String(day || ''),
      story: typeof verdict.story === 'string' ? verdict.story : '',
      handle: options.handle ? `@${String(options.handle).replace(/^@+/, '')}` : '',
      trim: ACCENTS[(options.prefs && options.prefs.accent) || 'amber'] || COLORS.amber,
    };
  }

  /** Spark painter: grade word huge, axis line, story, brand bar. NO PnL. */
  function drawSparkCard(ctx, model) {
    if (!ctx || !model || model.kind !== 'spark') return;
    ctx.save();
    paintBackground(ctx, model.background || 'void', WIDTH, HEIGHT);
    drawBrandingSafe(ctx, model);
    const cx = 64;
    let y = 150;
    // Grade, huge
    ctx.font = '800 120px Inter, system-ui, sans-serif';
    ctx.fillStyle = model.gradeColor;
    ctx.fillText(model.grade, cx, y);
    y += 64;
    ctx.font = '700 34px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(model.gradeLabel, cx, y);
    y += 44;
    ctx.font = '600 22px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(model.axisLine, cx, y);
    y += 36;
    if (model.story) {
      ctx.font = '500 20px Inter, system-ui, sans-serif';
      ctx.fillStyle = COLORS.faint;
      // Wrap the story to the card width.
      const words = model.story.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > WIDTH - 128) {
          ctx.fillText(line, cx, y);
          y += 28;
          line = w;
        } else {
          line = test;
        }
      }
      if (line) ctx.fillText(line, cx, y);
    }
    if (model.day) {
      y += 40;
      ctx.font = '600 18px ui-monospace, Menlo, monospace';
      ctx.fillStyle = COLORS.faint;
      ctx.fillText(model.day, cx, y);
    }
    if (model.handle) {
      ctx.font = '600 16px Inter, system-ui, sans-serif';
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(model.handle, WIDTH - 200, 40);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  /** Wrapped share-card model: the monthly discipline recap, NO PnL.
   * Consumes PTWrapped.derive() output. */
  function wrappedCardModel(model, opts) {
    if (!model || typeof model !== 'object' || !model.month) return null;
    const options = opts || {};
    const letter = String(model.letter || '').toUpperCase();
    const letterColor = {
      S: '#7C3AED', A: '#34D399', B: '#6AA9FF', C: '#FF9D45', D: '#FF5F56', F: '#FF2D2D',
    }[letter] || COLORS.text;
    const recovery = model.longestRecovery
      ? `${model.longestRecovery.days} day${model.longestRecovery.days === 1 ? '' : 's'} to come back`
      : 'no losing run this month';
    const symmetry = model.holdSymmetry
      ? `green ${formatHeld(model.holdSymmetry.greenAvgMs)} · red ${formatHeld(model.holdSymmetry.redAvgMs)}`
      : '—';
    const gotAway = model.oneThatGotAway
      ? `${model.oneThatGotAway.symbol || 'a coin'} ran ${Math.round(model.oneThatGotAway.maxPct)}% after you left`
      : 'nothing ran after you left';
    return {
      kind: 'wrapped',
      month: String(model.month),
      monthName: typeof model.monthName === 'string' ? model.monthName : String(model.month),
      year: Number(model.year) || new Date().getFullYear(),
      roundsText: `${model.rounds} rounds`,
      journalText: `${Math.round((model.journalRate || 0) * 100)}% journaled`,
      letter,
      letterColor,
      letterLabel: {
        S: 'flawless month', A: 'strong month', B: 'solid month',
        C: 'sloppy month', D: 'broke the rules', F: 'no discipline',
      }[letter] || 'month',
      recoveryText: recovery,
      symmetryText: symmetry,
      gotAwayText: gotAway,
      cleanText: `${model.cleanExits} clean exits`,
      handle: options.handle ? `@${String(options.handle).replace(/^@+/, '')}` : '',
      trim: ACCENTS[(options.prefs && options.prefs.accent) || 'amber'] || COLORS.amber,
    };
  }

  /** Wrapped painter: month headline, letter huge, discipline lines, brand
   * bar. NO PnL figure — the recap is process, never money. */
  function drawWrappedCard(ctx, model) {
    if (!ctx || !model || model.kind !== 'wrapped') return;
    ctx.save();
    paintBackground(ctx, model.background || 'void', WIDTH, HEIGHT);
    drawBrandingSafe(ctx, model);
    const cx = 64;
    let y = 150;
    // Month headline
    ctx.font = '800 44px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${model.monthName} ${model.year}`, cx, y);
    y += 28;
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('TRENCH WRAPPED', cx, y);
    y += 64;
    // Discipline letter, huge
    ctx.font = '800 120px Inter, system-ui, sans-serif';
    ctx.fillStyle = model.letterColor;
    ctx.fillText(model.letter, cx, y);
    y += 56;
    ctx.font = '700 30px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(model.letterLabel, cx, y);
    y += 44;
    // Discipline lines
    ctx.font = '600 22px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${model.roundsText} · ${model.journalText} · ${model.cleanText}`, cx, y);
    y += 34;
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`longest recovery: ${model.recoveryText}`, cx, y);
    y += 30;
    ctx.fillText(`hold symmetry: ${model.symmetryText}`, cx, y);
    y += 30;
    ctx.fillText(`the one that got away: ${model.gotAwayText}`, cx, y);
    if (model.handle) {
      ctx.font = '600 16px Inter, system-ui, sans-serif';
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(model.handle, WIDTH - 200, 40);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  /** Branding helper reusing drawBranding if present, else minimal. */
  function drawBrandingSafe(ctx, model) {
    try {
      if (typeof drawBranding === 'function') {
        drawBranding(ctx, model);
        return;
      }
    } catch (_) { /* fall through */ }
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, HEIGHT - BRAND_BAR_HEIGHT, WIDTH, BRAND_BAR_HEIGHT);
  }

  const api = {
    WIDTH, HEIGHT, COLORS, ACCENTS, WATERMARK_TEXT, BRAND_TEXT, BRAND_TAGLINE, SITE_URL,
    BACKGROUNDS, MAX_UPLOAD_BYTES, MAX_UPLOADS,
    cardModel, drawCard, coverRect, paintBackground, admitUpload, usdTotal,
    roundCardSource, positionCardSource,
    seasonCardSource, seasonCardModel, drawSeasonCard,
    sparkCardModel, drawSparkCard,
    wrappedCardModel, drawWrappedCard,
    formatPrice, formatMarketCap, formatSol, formatUsd, formatHeld, shortMint,
  };

  if (typeof window !== 'undefined') window.PTPnlCard = api;
  if (typeof self !== 'undefined') self.PTPnlCard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
