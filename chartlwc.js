// ============== ChartLW — TradingView lightweight-charts ==============

const safeMax = (arr, selector = x => x) => {
  if (!arr || !arr.length) return 0;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = selector(arr[i]);
    if (v > max) max = v;
  }
  return max;
};
const safeMin = (arr, selector = x => x) => {
  if (!arr || !arr.length) return 0;
  let min = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = selector(arr[i]);
    if (v < min) min = v;
  }
  return min;
};

const DrawIcons = {
  cursor: () => <svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 2l9.5 5.5-4 1 2.5 4.5-2 1-2.5-4.5-3 3z" /></svg>,
  line:   () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 13L13 3" /><circle cx="3" cy="13" r="1.3" fill="currentColor" /><circle cx="13" cy="3" r="1.3" fill="currentColor" /></svg>,
  hline:  () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 8h12" /><circle cx="2" cy="8" r="1.3" fill="currentColor" /><circle cx="14" cy="8" r="1.3" fill="currentColor" /></svg>,
  box:    () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="3" width="10" height="10" /></svg>,
  long:   () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 14V3" /><path d="M4 7l4-4 4 4" /></svg>,
  short:  () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v11" /><path d="M4 9l4 4 4-4" /></svg>,
  text:   () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4h8M8 4v9" /></svg>,
  trash:  () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9" /></svg>,
  undo:   () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8a5 5 0 1 1 1.6 3.6" /><path d="M3 4v4h4" /></svg>,
  grip:   () => <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5.5" cy="5" r="1.2"/><circle cx="10.5" cy="5" r="1.2"/><circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/><circle cx="5.5" cy="11" r="1.2"/><circle cx="10.5" cy="11" r="1.2"/></svg>,
};

// === Custom Series: Footprint cells ===
function createFootprintSeriesView() {
  const TICK = 0.25;
  const renderer = {
    _data: null,
    _opts: null,
    draw(target, priceConverter) {
      const data = this._data, opts = this._opts;
      if (!data || !opts || opts.mode === 'candle') return;
      target.useMediaCoordinateSpace((scope) => {
        const ctx = scope.context;
        const bars = data.bars;
        if (!bars || bars.length === 0) return;
        const canvasH = ctx.canvas.height;

        // --- Measure barSpacing ---
        let barSpacing = opts.barSpacing || 0;
        if (!barSpacing) {
          const dxSamples = [];
          for (let i = 1; i < Math.min(bars.length, 12); i++) {
            const dx = bars[i].x - bars[i - 1].x;
            if (dx > 0) dxSamples.push(dx);
          }
          if (dxSamples.length > 0) {
            dxSamples.sort((a, b) => a - b);
            barSpacing = dxSamples[Math.floor(dxSamples.length / 2)];
          } else {
            barSpacing = 38;
          }
        }

        const { mode, showDelta, showImb, buyColor, sellColor, bg } = opts;

        // --- Measure pxPerTick ---
        let pxPerTick = 0;
        for (const bar of bars) {
          const od = bar.originalData;
          const refPrice = od.close ?? od.c;
          if (refPrice == null) continue;
          const y0 = priceConverter(refPrice);
          const y1 = priceConverter(refPrice + TICK);
          if (y0 != null && y1 != null) { pxPerTick = Math.abs(y1 - y0); break; }
        }

        const showFP = barSpacing >= 28 && pxPerTick >= 6;

        // --- Draw candles ---
        const candleW = showFP ? Math.max(3, barSpacing * 0.07) : Math.max(3, barSpacing * 0.6);
        for (const bar of bars) {
          const od = bar.originalData;
          const yO = priceConverter(od.open ?? od.o);
          const yC = priceConverter(od.close ?? od.c);
          const yH = priceConverter(od.high ?? od.h);
          const yL = priceConverter(od.low ?? od.l);
          if (yO == null || yC == null || yH == null || yL == null) continue;
          const isUp = (od.close ?? od.c) >= (od.open ?? od.o);
          const col = isUp ? buyColor : sellColor;
          const bodyTop = Math.min(yO, yC);
          const bodyH = Math.max(1, Math.abs(yC - yO));
          if (!showFP) {
            ctx.fillStyle = col;
            ctx.fillRect(bar.x - 0.5, Math.min(yH, yL), 1, Math.abs(yL - yH));
            if (isUp) {
              ctx.strokeStyle = col; ctx.lineWidth = 1;
              ctx.strokeRect(bar.x - candleW / 2, bodyTop, candleW, bodyH);
            } else {
              ctx.fillRect(bar.x - candleW / 2, bodyTop, candleW, bodyH);
            }
          } else {
            const candleX = bar.x - barSpacing * 0.43;
            ctx.fillStyle = col;
            ctx.fillRect(candleX - 0.5, Math.min(yH, yL), 1, Math.abs(yL - yH));
            ctx.fillRect(candleX - candleW / 2, bodyTop, candleW, bodyH);
          }
        }

        if (!showFP) return;

        // --- Footprint cells (optimised) ---
        const cellH = pxPerTick;
        const tFont = 11;
        const candleColW = candleW + 3;
        const fpAreaW = barSpacing * 0.86 - candleColW;
        const gapW = Math.max(1, fpAreaW * 0.02);
        const colW = (fpAreaW - gapW) / 2;
        if (colW < 3) return;
        const showText = colW > 18 && cellH >= 12;

        // Y-axis viewport cull margin
        const cullTop = -cellH;
        const cullBot = canvasH + cellH;

        // Set text properties once (not per-cell)
        ctx.font = `700 ${tFont}px 'JetBrains Mono', ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const isBidAsk = mode === 'bidask';
        const isProfile = mode === 'profile';
        const showDeltaText = showDelta && showText && !isBidAsk;

        for (const bar of bars) {
          const fp = bar.originalData.footprint;
          if (!fp || !fp.length) continue;

          // Per-bar max — avoid spread operator on large arrays
          let barMax = 1, rowTotalMax = 1;
          for (let i = 0; i < fp.length; i++) {
            const b = fp[i].bid, a = fp[i].ask;
            if (b > barMax) barMax = b;
            if (a > barMax) barMax = a;
            const t = b + a;
            if (t > rowTotalMax) rowTotalMax = t;
          }
          const invBarMax = 1 / barMax;

          const barLeft = bar.x - barSpacing * 0.43;
          const bidX = barLeft + candleColW;
          const askX = bidX + colW + gapW;
          const bidCX = Math.round(bidX + colW / 2);
          const askCX = Math.round(askX + colW / 2);

          // --- Pass 1: background fills (batch by color to minimise fillStyle swaps) ---
          if (isBidAsk) {
            ctx.fillStyle = sellColor;
            for (let i = 0; i < fp.length; i++) {
              const y = priceConverter(fp[i].px);
              if (y == null || y < cullTop || y > cullBot) continue;
              const yT = y - cellH / 2 + 0.5;
              const boxH = cellH - 1;
              ctx.globalAlpha = 0.10 + Math.min(1, fp[i].bid * invBarMax) * 0.65;
              ctx.fillRect(bidX, yT, colW, boxH);
            }
            ctx.fillStyle = buyColor;
            for (let i = 0; i < fp.length; i++) {
              const y = priceConverter(fp[i].px);
              if (y == null || y < cullTop || y > cullBot) continue;
              const yT = y - cellH / 2 + 0.5;
              const boxH = cellH - 1;
              ctx.globalAlpha = 0.10 + Math.min(1, fp[i].ask * invBarMax) * 0.65;
              ctx.fillRect(askX, yT, colW, boxH);
            }

            // --- Imbalance overlay (before text so text draws on top) ---
            if (showImb) {
              for (let i = 0; i < fp.length; i++) {
                const f = fp[i];
                if (!f.askImb && !f.bidImb) continue;
                const y = priceConverter(f.px);
                if (y == null || y < cullTop || y > cullBot) continue;
                const yT = y - cellH / 2 + 0.5;
                const boxH = cellH - 1;
                ctx.globalAlpha = 0.45;
                if (f.askImb) { ctx.fillStyle = buyColor; ctx.fillRect(askX, yT, colW, boxH); }
                if (f.bidImb) { ctx.fillStyle = sellColor; ctx.fillRect(bidX, yT, colW, boxH); }
              }
            }

            // --- Pass 2: all text in one batch ---
            if (showText) {
              ctx.fillStyle = '#ffffff';
              ctx.globalAlpha = 1;
              if (showDelta) {
                // Delta mode: single centered column with net delta per row
                for (let i = 0; i < fp.length; i++) {
                  const f = fp[i];
                  const y = priceConverter(f.px);
                  if (y == null || y < cullTop || y > cullBot) continue;
                  const dl = f.ask - f.bid;
                  ctx.fillText((dl >= 0 ? '+' : '') + dl, bar.x, Math.round(y + 0.5));
                }
              } else {
                for (let i = 0; i < fp.length; i++) {
                  const f = fp[i];
                  const y = priceConverter(f.px);
                  if (y == null || y < cullTop || y > cullBot) continue;
                  const textY = Math.round(y + 0.5);
                  ctx.fillText('' + f.bid, bidCX, textY);
                  ctx.fillText('' + f.ask, askCX, textY);
                }
              }
            }
          } else if (isProfile) {
            const totalW = barSpacing * 0.86;
            const xL = bar.x - totalW / 2;
            ctx.globalAlpha = 0.55;
            for (let i = 0; i < fp.length; i++) {
              const f = fp[i];
              const y = priceConverter(f.px);
              if (y == null || y < cullTop || y > cullBot) continue;
              const yT = y - cellH / 2 + 0.5;
              const boxH = cellH - 1;
              const dl = f.ask - f.bid;
              const rowTotal = f.bid + f.ask;
              const w = (rowTotal / rowTotalMax) * totalW;
              ctx.fillStyle = dl >= 0 ? buyColor : sellColor;
              ctx.fillRect(xL, yT + 1, w, boxH - 1);
            }
            ctx.globalAlpha = 1;

            if (showImb) {
              const xL2 = bar.x - totalW / 2;
              ctx.globalAlpha = 0.35;
              for (let i = 0; i < fp.length; i++) {
                const f = fp[i];
                if (!f.askImb && !f.bidImb) continue;
                const y = priceConverter(f.px);
                if (y == null || y < cullTop || y > cullBot) continue;
                const yT = y - cellH / 2 + 0.5;
                const boxH = cellH - 1;
                ctx.fillStyle = f.askImb ? buyColor : sellColor;
                ctx.fillRect(xL2, yT, totalW, boxH);
              }
              ctx.globalAlpha = 1;
            }

            // Delta text
            if (showDeltaText) {
              ctx.fillStyle = '#ffffff';
              ctx.globalAlpha = 1;
              for (let i = 0; i < fp.length; i++) {
                const f = fp[i];
                const y = priceConverter(f.px);
                if (y == null || y < cullTop || y > cullBot) continue;
                const dl = f.ask - f.bid;
                ctx.fillText((dl >= 0 ? '+' : '') + dl, bar.x, Math.round(y + 0.5));
              }
            }
          }
        }
        ctx.globalAlpha = 1;
      });
    },
  };

  return {
    _r: renderer,
    defaultOptions() {
      return {
        mode: 'bidask', showDelta: true, showImb: true, barSpacing: 38,
        buyColor: '#5ab5e6', sellColor: '#e85030', bg: '#0e1116', fg: '#dde1e8',
        priceLineVisible: false, lastValueVisible: false,
      };
    },
    priceValueBuilder(plotRow) {
      return [plotRow.low, plotRow.high];
    },
    isWhitespace(data) {
      return !data || data.open == null;
    },
    renderer() {
      return this._r;
    },
    update(data, options) {
      this._r._data = data;
      this._r._opts = options;
    },
  };
}

function ChartLW(props) {
  const {
    mode, setMode,
    showDelta, setShowDelta,
    showImb, setShowImb,
    showDailyVP, setShowDailyVP,
    showWeeklyVP, setShowWeeklyVP,
    showVol, setShowVol,
    showAbsorption,  setShowAbsorption,
    showExhaustion,  setShowExhaustion,
    showStackedImb,  setShowStackedImb,
    showUFAMarks,    setShowUFAMarks,
    showUFLines,     setShowUFLines,
    showWalls,       setShowWalls,
    showShiftCandle, setShowShiftCandle,
    showDivergence,  setShowDivergence,
    showLargePrints, setShowLargePrints,
    showGex, setShowGex,
    instrument,
  } = props;

  const [overlayMenuOpen, setOverlayMenuOpen] = React.useState(false);
  const overlayMenuRef = React.useRef(null);
  React.useEffect(() => {
    if (!overlayMenuOpen) return;
    const handler = (e) => {
      if (overlayMenuRef.current && !overlayMenuRef.current.contains(e.target))
        setOverlayMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [overlayMenuOpen]);

  const overlayItems = [
    { key: 'abs',   label: 'Absorption',    val: showAbsorption,  set: setShowAbsorption },
    { key: 'exh',   label: 'Exhaustion',    val: showExhaustion,  set: setShowExhaustion },
    { key: 'simb',  label: 'Stacked Imb',   val: showStackedImb,  set: setShowStackedImb },
    { key: 'ufa',   label: 'UFA Marks',     val: showUFAMarks,    set: setShowUFAMarks },
    null,
    { key: 'ufl',   label: 'UF Lines',      val: showUFLines,     set: setShowUFLines },
    { key: 'wall',  label: 'Walls',         val: showWalls,       set: setShowWalls },
{ key: 'shift', label: 'Shift Candle',  val: showShiftCandle, set: setShowShiftCandle },
    { key: 'div',   label: 'Divergence',    val: showDivergence,  set: setShowDivergence },
    null,
    { key: 'lp',    label: 'Large Prints',  val: showLargePrints, set: setShowLargePrints },
  ];
  const anyOverlay = overlayItems.filter(Boolean).some(o => o.val);

  const instrData = (window.OF_DATA_BY_SYM && window.OF_DATA_BY_SYM[instrument]) || window.OF_DATA;
  const { candles, sessionStats, vp, dailyVP, weeklyVP } = instrData;
  const fps = window.OF_FOOTPRINT_STATS;
  const TICK = 0.25;
  const isFP = mode !== 'candle';

  const C = {
    bg:    '#0e1116',
    text:  '#737880',
    fg:    '#dde1e8',
    fg1:   '#b0b5c0',
    line:  '#232a37',
    lineS: '#1c222d',
    panel: '#1a1f2a',
    buy:   '#5ab5e6',
    sell:  '#e85030',
    buyT:  'rgba(90, 181, 230, 0.55)',
    sellT: 'rgba(232, 80, 48, 0.55)',
  };

  const containerRef = React.useRef(null);
  const chartRef = React.useRef(null);
  const seriesRef = React.useRef(null);
  const volSeriesRef = React.useRef(null);
  const askSeriesRef = React.useRef(null);
  const fpSeriesRef = React.useRef(null);
  const vwapLineRef = React.useRef(null);
  const pocLineRef = React.useRef(null);
  const prevCandleCountRef = React.useRef(0);

  const [, forceRender] = React.useReducer((x) => (x + 1) % 1e9, 0);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [psWidth, setPsWidth] = React.useState(60);
  const didInitialFitRef = React.useRef(false);

  const [tool, setTool] = React.useState('cursor');
  const [drawings, setDrawings] = React.useState([]);
  const [toolbarPos, setToolbarPos] = React.useState(null);

  const onToolbarDragStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const toolbarEl = e.currentTarget.closest('.draw-toolbar');
    const canvasEl = toolbarEl.parentElement;
    const toolbarRect = toolbarEl.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    const offsetX = e.clientX - toolbarRect.left;
    const offsetY = e.clientY - toolbarRect.top;
    const onMove = (me) => {
      setToolbarPos({
        x: Math.max(0, me.clientX - canvasRect.left - offsetX),
        y: Math.max(0, me.clientY - canvasRect.top - offsetY),
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const [pending, setPending] = React.useState(null);
  const [gexLevels, setGexLevels] = React.useState([]);
  const [gexProfile, setGexProfile] = React.useState({});

  // Fetch GEX levels file; reload on gex-run completion or at midnight
  React.useEffect(() => {
    const load = () => {
      fetch('data/gex_levels.json?_=' + Date.now())
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.levels) setGexLevels(d.levels); if (d?.profile) setGexProfile(d.profile); })
        .catch(() => {});
    };
    load();
    document.addEventListener('of-gex-update', load);
    const msToMidnight = () => {
      const n = new Date();
      return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1) - n;
    };
    const tid = setTimeout(() => { load(); }, msToMidnight());
    return () => {
      clearTimeout(tid);
      document.removeEventListener('of-gex-update', load);
    };
  }, []);

  // ---- init chart once ----
  React.useEffect(() => {
    const LWC = window.LightweightCharts;
    const el = containerRef.current;
    if (!LWC || !el) return;

    const initW = el.clientWidth || 800;
    const initH = el.clientHeight || 400;

    const chart = LWC.createChart(el, {
      width: initW,
      height: initH,
      layout: {
        background: { type: 'solid', color: C.bg },
        textColor: C.text,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: C.lineS },
        horzLines: { color: C.lineS },
      },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: C.text, width: 1, style: LWC.LineStyle.Dotted, labelBackgroundColor: C.panel },
        horzLine: { color: C.text, width: 1, style: LWC.LineStyle.Dotted, labelBackgroundColor: C.panel },
      },
      timeScale: {
        borderColor: C.line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 14,
      },
      rightPriceScale: {
        borderColor: C.line,
        scaleMargins: { top: 0.06, bottom: 0.22 },
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: C.bg,
      downColor: C.sell,
      borderUpColor: C.buy,
      borderDownColor: C.sell,
      wickUpColor: C.buy,
      wickDownColor: C.sell,
      priceFormat: { type: 'price', precision: 2, minMove: TICK },
    });
    series.setData(candles.map((c) => ({
      time: c.time, open: c.o, high: c.h, low: c.l, close: c.c,
    })));
    vwapLineRef.current = series.createPriceLine({
      price: sessionStats.vwap, color: C.text, lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: 'VWAP',
    });
    pocLineRef.current = series.createPriceLine({
      price: vp.poc, color: C.buy, lineWidth: 1,
      lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'POC',
    });

    const vols = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      color: C.sellT,
    });
    vols.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      drawTicks: false,
      borderVisible: false,
      visible: false,
    });
    const askPct = (c) => c.ask + c.bid > 0 ? c.ask / (c.ask + c.bid) : 0.5;
    vols.setData(candles.map((c) => ({ time: c.time, value: c.vol, color: C.sellT })));

    const asks = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      color: C.buyT,
    });
    asks.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      drawTicks: false,
      borderVisible: false,
      visible: false,
    });
    asks.setData(candles.map((c) => ({ time: c.time, value: c.vol * askPct(c), color: C.buyT })));

    chartRef.current = chart;
    seriesRef.current = series;
    volSeriesRef.current = vols;
    askSeriesRef.current = asks;

    // Custom Series for footprint cells
    let fpSeries = null;
    try {
      const fpView = createFootprintSeriesView();
      fpSeries = chart.addCustomSeries(fpView, {
        mode: props.mode,
        showDelta: props.showDelta,
        showImb: props.showImb,
        buyColor: C.buy,
        sellColor: C.sell,
        bg: C.bg,
        fg: C.fg,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      fpSeries.setData(candles.map((c) => ({
        time: c.time, open: c.o, close: c.c, low: c.l, high: c.h, footprint: c.footprint,
      })));
      fpSeriesRef.current = fpSeries;
    } catch (e) {
      console.warn('Custom Series unavailable', e);
    }

    chart.timeScale().applyOptions({ barSpacing: props.mode === 'candle' ? 14 : 38 });
    chart.timeScale().fitContent();

    const onRangeChange = () => {
      try { setPsWidth(chart.priceScale('right').width()); } catch (e) {}
      // Pass authoritative barSpacing to the custom series so it doesn't have to guess
      try {
        if (fpSeriesRef.current) {
          fpSeriesRef.current.applyOptions({ barSpacing: chart.timeScale().options().barSpacing });
        }
      } catch (e) {}
      forceRender();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      try { chart.resize(width, height); } catch (e) {}
      setSize({ w: width, h: height });
      try { setPsWidth(chart.priceScale('right').width()); } catch (e) {}
      forceRender();
    });
    ro.observe(el);

    requestAnimationFrame(() => {
      try { chart.resize(el.clientWidth, el.clientHeight); } catch (e) {}
      setSize({ w: el.clientWidth, h: el.clientHeight });
      try { setPsWidth(chart.priceScale('right').width()); } catch (e) {}
      forceRender();
    });

    return () => { ro.disconnect(); try { chart.remove(); } catch(e){} chartRef.current = null; };
  }, []);


  // Volume series visibility
  React.useEffect(() => {
    if (!volSeriesRef.current) return;
    volSeriesRef.current.applyOptions({ visible: showVol });
    if (askSeriesRef.current) askSeriesRef.current.applyOptions({ visible: showVol });
  }, [showVol]);

  // Reset candle count ref on instrument switch so the sync effect always calls setData
  React.useEffect(() => {
    prevCandleCountRef.current = -1;
  }, [instrument]);

  // Track previous mode so we only reset barSpacing on candle↔FP transitions
  const prevModeRef = React.useRef(mode);

  // FP series display options — safe to run on any overlay toggle, no LWC scroll side-effects
  React.useEffect(() => {
    if (fpSeriesRef.current) {
      fpSeriesRef.current.applyOptions({ mode, showDelta, showImb });
    }
  }, [mode, showDelta, showImb]);

  // Candlestick visibility + barSpacing — only reacts to mode changes to avoid spurious chart jumps
  React.useEffect(() => {
    if (!chartRef.current) return;
    if (seriesRef.current) {
      seriesRef.current.applyOptions({ visible: mode === 'candle' });
    }
    const wasFP = prevModeRef.current !== 'candle';
    const isFPNow = mode !== 'candle';
    if (wasFP !== isFPNow) {
      // Preserve visible time range so bars don't fly when bar width changes
      const prevRange = chartRef.current.timeScale().getVisibleLogicalRange();
      chartRef.current.timeScale().applyOptions({ barSpacing: isFPNow ? 38 : 14 });
      if (prevRange) chartRef.current.timeScale().setVisibleLogicalRange(prevRange);
    }
    prevModeRef.current = mode;
  }, [mode]);

  // ---- sync series data whenever candles update ----
  React.useEffect(() => {
    if (!seriesRef.current) return;

    // Clear all series when switching to an instrument with no data yet
    if (!candles.length) {
      seriesRef.current.setData([]);
      if (volSeriesRef.current) volSeriesRef.current.setData([]);
      if (askSeriesRef.current) askSeriesRef.current.setData([]);
      if (fpSeriesRef.current)  fpSeriesRef.current.setData([]);
      prevCandleCountRef.current = 0;
      return;
    }

    const prevCount = prevCandleCountRef.current;
    const newCount = candles.length;

    if (newCount !== prevCount) {
      // New bar added or bars reset — full setData
      seriesRef.current.setData(candles.map((c) => ({
        time: c.time, open: c.o, high: c.h, low: c.l, close: c.c,
      })));
      if (volSeriesRef.current) {
        volSeriesRef.current.setData(candles.map((c) => ({ time: c.time, value: c.vol, color: C.sellT })));
        if (askSeriesRef.current) askSeriesRef.current.setData(candles.map((c) => ({ time: c.time, value: c.vol * (c.ask + c.bid > 0 ? c.ask / (c.ask + c.bid) : 0.5), color: C.buyT })));
      }
      if (fpSeriesRef.current) {
        fpSeriesRef.current.setData(candles.map((c) => ({
          time: c.time, open: c.o, close: c.c, low: c.l, high: c.h, footprint: c.footprint,
        })));
      }
      prevCandleCountRef.current = newCount;
    } else {
      // Same bar count — just update the last bar
      const last = candles[candles.length - 1];
      seriesRef.current.update({
        time: last.time, open: last.o, high: last.h, low: last.l, close: last.c,
      });
      if (volSeriesRef.current) {
        volSeriesRef.current.update({ time: last.time, value: last.vol, color: C.sellT });
        if (askSeriesRef.current) askSeriesRef.current.update({ time: last.time, value: last.vol * (last.ask + last.bid > 0 ? last.ask / (last.ask + last.bid) : 0.5), color: C.buyT });
      }
      if (fpSeriesRef.current) {
        fpSeriesRef.current.setData(candles.map((c) => ({
          time: c.time, open: c.o, close: c.c, low: c.l, high: c.h, footprint: c.footprint,
        })));
      }
    }

    // Update VWAP and POC price lines
    if (vwapLineRef.current && sessionStats.vwap > 0) {
      vwapLineRef.current.applyOptions({ price: sessionStats.vwap });
    }
    if (pocLineRef.current && vp.poc > 0) {
      pocLineRef.current.applyOptions({ price: vp.poc });
    }

    // Scroll to show live data the first time candles arrive
    if (!didInitialFitRef.current && chartRef.current) {
      chartRef.current.timeScale().fitContent();
      didInitialFitRef.current = true;
    }
  }, [candles, instrument]);

  // ---- coordinate helpers ----
  const t2x = (t) => chartRef.current ? chartRef.current.timeScale().timeToCoordinate(t) : null;
  const p2y = (p) => seriesRef.current ? seriesRef.current.priceToCoordinate(p) : null;
  const x2t = (x) => chartRef.current ? chartRef.current.timeScale().coordinateToTime(x) : null;
  const y2p = (y) => seriesRef.current ? seriesRef.current.coordinateToPrice(y) : null;

  let barSpacing = 14;
  if (chartRef.current) {
    for (let i = 1; i < Math.min(candles.length, 30); i++) {
      const a = t2x(candles[i - 1].time);
      const b = t2x(candles[i].time);
      if (a != null && b != null && b !== a) { barSpacing = b - a; break; }
    }
  }

  // ---- pxPerTick for VP cell heights ----
  const pxPerTick = (() => {
    if (!candles.length) return 4;
    const ref = candles[candles.length - 1].c;
    const y0 = p2y(ref), y1 = p2y(ref + TICK);
    return (y0 != null && y1 != null) ? Math.abs(y1 - y0) : 4;
  })();


  // ---- drawing handlers ----
  const onDown = (e) => {
    if (tool === 'cursor') return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = x2t(x), pr = y2p(y);
    if (t == null || pr == null) return;
    const p = Math.round(pr / TICK) * TICK;
    const a = { t, p };
    if (tool === 'hline') {
      setDrawings((d) => [...d, { id: Date.now(), type: 'hline', a, b: a }]);
      setTool('cursor'); return;
    }
    if (tool === 'text') {
      const label = window.prompt('Note:');
      if (label) setDrawings((d) => [...d, { id: Date.now(), type: 'text', a, b: a, label }]);
      setTool('cursor'); return;
    }
    setPending({ id: Date.now(), type: tool, a, b: a });
  };
  const onMove = (e) => {
    if (!pending) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = x2t(x), pr = y2p(y);
    if (t == null || pr == null) return;
    setPending({ ...pending, b: { t, p: Math.round(pr / TICK) * TICK } });
  };
  const onUp = () => {
    if (!pending) return;
    if (pending.a.t !== pending.b.t || pending.a.p !== pending.b.p) {
      setDrawings((d) => [...d, pending]);
    }
    setPending(null); setTool('cursor');
  };

  const W = size.w, H = size.h;
  const xPxRight = Math.max(0, W - psWidth - 2);
  const vpWidth = Math.min(170, W * 0.24);
  const cellWBase = Math.max(2, barSpacing * 0.86);
  const lastBar = candles[candles.length - 1];

  return (
    <div className="panel p-chart">
      <div className="panel-h">
        <span className="title">ES — March 2026</span>
        <span className="sep" />
        <span className="meta">5 MIN · CME</span>
        <span className="spacer" />
        <div className="seg">
          {[['candle','Candle'],['bidask','Bid×Ask'],['profile','Profile']].map(([k, label]) => (
            <button key={k} className={mode===k?'active':''} onClick={()=>setMode(k)}>{label}</button>
          ))}
        </div>
        <span className="sep" />
        <div className="seg">
          <button className={'toggle '+(showDelta?'on':'')} onClick={()=>setShowDelta(!showDelta)} title="Delta overlay">Δ</button>
          <button className={'toggle '+(showImb?'on':'')} onClick={()=>setShowImb(!showImb)} title="Imbalance highlights">Imb</button>
        </div>
        <span className="sep" />
        <div className="seg">
          <button className={'toggle '+(showDailyVP?'on':'')} onClick={()=>setShowDailyVP(!showDailyVP)} title="Daily Volume Profile">DlyVP</button>
          <button className={'toggle '+(showWeeklyVP?'on':'')} onClick={()=>setShowWeeklyVP(!showWeeklyVP)} title="Weekly Volume Profile">WkVP</button>
          <button className={'toggle '+(showVol?'on':'')} onClick={()=>setShowVol(!showVol)}>Vol</button>
        </div>
        <span className="sep" />
        <div className="seg">
          <button className={'toggle '+(showGex?'on':'')} onClick={()=>setShowGex(!showGex)} title="GEX levels overlay">GEX</button>
        </div>
        <div className="overlay-menu-wrap" ref={overlayMenuRef}>
          <button className={'toggle '+(anyOverlay?'on':'')} onClick={()=>setOverlayMenuOpen(o=>!o)}>Overlays ▾</button>
          {overlayMenuOpen && (
            <div className="overlay-menu">
              {overlayItems.map((item, i) =>
                item === null
                  ? <div key={'sep'+i} className="overlay-menu-sep" />
                  : <label key={item.key} className="overlay-menu-row">
                      <input type="checkbox" checked={item.val} onChange={()=>item.set(!item.val)} />
                      {item.label}
                    </label>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="chart-canvas">
        <div ref={containerRef} style={{ position:'absolute', inset:0 }} />

        <svg
          width={W} height={H}
          style={{
            position:'absolute', inset:0, zIndex:2,
            pointerEvents: tool === 'cursor' ? 'none' : 'auto',
            cursor: tool !== 'cursor' ? 'crosshair' : 'default',
          }}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={() => { if (pending) { setPending(null); setTool('cursor'); } }}
        >
          {/* VP overlay removed — rendered in strip below chart */}

          {/* ── GEX Profile (kebab) — per-strike gamma, left side ── */}
          {showGex && chartRef.current && (() => {
            const entries = Object.entries(gexProfile);
            if (!entries.length) return null;

            // Chart's current last price — used to scale strikes proportionally
            const chartSpot = lastBar?.close ?? candles[candles.length - 1]?.close ?? 0;
            if (!chartSpot) return null;

            // Prefer NQ, then NDX, then QQQ
            const order = ['NQ', 'NDX', 'QQQ'];
            const sorted = [...entries].sort((a, b) => {
              const ai = order.indexOf(a[0]), bi = order.indexOf(b[0]);
              return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });

            for (const [inst, data] of sorted) {
              if (!data?.strikes?.length || !data.spot) continue;

              // Scale each strike relative to the instrument spot → chart spot
              const scale = chartSpot / data.spot;

              // OPTIMIZATION: Get current price bounds from the chart to avoid converting thousands of strikes
              const logicalRange = chartRef.current.timeScale().getVisibleLogicalRange();
              if (!logicalRange) continue;
              const pLo = y2p(H), pHi = y2p(0);
              if (pLo == null || pHi == null) continue;

              // Only process strikes that could possibly be visible
              const visible = [];
              for (const [px, gex] of data.strikes) {
                const scaledPx = px * scale;
                if (scaledPx >= pLo * 0.95 && scaledPx <= pHi * 1.05) {
                  visible.push([scaledPx, gex]);
                }
              }
              if (!visible.length) continue;

              const maxAbs = safeMax(visible, ([, g]) => Math.abs(g));
              if (maxAbs === 0) continue;

              const stripW = Math.max(50, Math.min(80, W * 0.07));
              const spineX = stripW / 2;
              const maxBarHalf = spineX - 4;
              const barH = 3;

              return (
                <g key="gex-profile">
                  <rect x={0} y={0} width={stripW} height={H} fill={C.bg} fillOpacity="0.55" />
                  <line x1={spineX} x2={spineX} y1={0} y2={H} stroke="#555" strokeWidth="0.75" opacity="0.6" />
                  {visible.map(([px, gex], i) => {
                    const y = p2y(px);
                    if (y == null) return null;
                    const barLen = (Math.abs(gex) / maxAbs) * maxBarHalf;
                    if (barLen < 0.5) return null;
                    const isPos = gex >= 0;
                    const x1 = isPos ? spineX : spineX - barLen;
                    const col = isPos ? '#3fb950' : '#f85149';
                    return (
                      <rect key={i} x={x1} y={y - barH / 2} width={barLen} height={barH}
                        fill={col} opacity="0.75" />
                    );
                  })}
                  <text x={3} y={12} fontSize="8" fill="#888" fontFamily="JetBrains Mono" opacity="0.85">{inst} γ</text>
                </g>
              );
            }
            return null;
          })()}

          {/* ── Daily Volume Profile (left side, current session) ── */}
          {showDailyVP && chartRef.current && dailyVP && (() => {
            const dvp = dailyVP[dailyVP.length - 1];
            if (!dvp || !dvp.rows.length) return null;
            const dvpMax = Math.max(1, ...dvp.rows.map(r => r.buy + r.sell));
            const dvpWidth = Math.max(20, W * 0.035);
            return (
              <g>
                {dvp.rows.map((r, i) => {
                  const y = p2y(r.px);
                  if (y == null) return null;
                  const w = ((r.buy + r.sell) / dvpMax) * dvpWidth;
                  const col = r.va ? '#f0920a' : '#eedd00';
                  return <rect key={'dvp'+i} x={0} y={y - 2} width={w} height={4} fill={col} opacity={r.poc ? 0.9 : 0.55} />;
                })}
                {(() => { const y = p2y(dvp.vah); return y != null ? (
                  <g>
                    <line x1={0} x2={dvpWidth} y1={y} y2={y} stroke="#f0920a" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                    <text x={dvpWidth + 4} y={y + 3} fontSize="8" fill="#f0920a" textAnchor="start" fontFamily="JetBrains Mono" opacity="0.7">VAH</text>
                  </g>
                ) : null; })()}
                {(() => { const y = p2y(dvp.val); return y != null ? (
                  <g>
                    <line x1={0} x2={dvpWidth} y1={y} y2={y} stroke="#f0920a" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                    <text x={dvpWidth + 4} y={y + 3} fontSize="8" fill="#f0920a" textAnchor="start" fontFamily="JetBrains Mono" opacity="0.7">VAL</text>
                  </g>
                ) : null; })()}
                {(() => { const y = p2y(dvp.poc); return y != null ? (
                  <g>
                    <line x1={0} x2={dvpWidth} y1={y} y2={y} stroke="#f59e42" strokeWidth="1.2" strokeDasharray="6 3" opacity="0.4" />
                    <text x={dvpWidth + 4} y={y + 3} fontSize="8" fill="#f59e42" textAnchor="start" fontFamily="JetBrains Mono" opacity="0.7">POC</text>
                  </g>
                ) : null; })()}
              </g>
            );
          })()}

          {/* ── Weekly Volume Profile overlay (right side, bars point left) ── */}
          {showWeeklyVP && chartRef.current && weeklyVP && (() => {
            const wvp = weeklyVP[weeklyVP.length - 1];
            if (!wvp || !wvp.rows.length) return null;
            const wvpMax = Math.max(1, ...wvp.rows.map(r => r.buy + r.sell));
            const wvpWidth = Math.max(30, W * 0.05);
            const wvpX0 = xPxRight - wvpWidth;
            return (
              <g>
                {wvp.rows.map((r, i) => {
                  const y = p2y(r.px);
                  if (y == null) return null;
                  const total = r.buy + r.sell;
                  const w = (total / wvpMax) * wvpWidth;
                  const col = r.va ? '#7c3aed' : '#e9b8ff';
                  return (
                    <rect key={'wvp'+i} x={xPxRight - w} y={y - 2} width={w} height={4} fill={col} opacity={r.poc ? 0.9 : 0.55} />
                  );
                })}
                {/* VAH line */}
                {(() => { const y = p2y(wvp.vah); return y != null ? (
                  <g>
                    <line x1={wvpX0} x2={xPxRight} y1={y} y2={y} stroke="#c084fc" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                    <text x={wvpX0 - 4} y={y + 3} fontSize="8" fill="#c084fc" textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">wVAH</text>
                  </g>
                ) : null; })()}
                {/* VAL line */}
                {(() => { const y = p2y(wvp.val); return y != null ? (
                  <g>
                    <line x1={wvpX0} x2={xPxRight} y1={y} y2={y} stroke="#c084fc" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                    <text x={wvpX0 - 4} y={y + 3} fontSize="8" fill="#c084fc" textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">wVAL</text>
                  </g>
                ) : null; })()}
                {/* POC line */}
                {(() => { const y = p2y(wvp.poc); return y != null ? (
                  <g>
                    <line x1={wvpX0} x2={xPxRight} y1={y} y2={y} stroke="#a855f7" strokeWidth="1.2" strokeDasharray="6 3" opacity="0.4" />
                    <text x={wvpX0 - 4} y={y + 3} fontSize="8" fill="#a855f7" textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">wPOC</text>
                  </g>
                ) : null; })()}
              </g>
            );
          })()}

          {/* ── Indicator Overlays ── */}
          {chartRef.current && (() => {
            const ind = window.OF_INDICATORS || {};

            // 1. UnfinishedAuction — dashed horizontal lines at open levels
            const uaElems = showUFLines ? (ind.unfinishedAuction?.openLevels || []).map((lvl, i) => {
              const y = p2y(lvl.px);
              if (y == null) return null;
              const col = lvl.type === 'HIGH' ? C.sell : C.buy;
              return (
                <g key={'ua'+i}>
                  <line x1={0} x2={xPxRight} y1={y} y2={y} stroke={col} strokeWidth="1.2" strokeDasharray="4 3" opacity="0.7" />
                  <text x={xPxRight - 2} y={y - 3} fontSize="8" fill={col} textAnchor="end" fontFamily="JetBrains Mono">
                    {lvl.type === 'HIGH' ? 'UF↑' : 'UF↓'}
                  </text>
                </g>
              );
            }) : [];

            // 2. DeepWall — solid horizontal lines at active wall prices
            const wallElems = showWalls ? (ind.deepWall?.activeWalls || []).map((wall, i) => {
              const y = p2y(wall.px);
              if (y == null) return null;
              const col = wall.side === 'ASK' ? C.sell : C.buy;
              const sw  = wall.domConfirmed ? 2 : 1;
              return (
                <g key={'wall'+i}>
                  <line x1={0} x2={xPxRight} y1={y} y2={y} stroke={col} strokeWidth={sw} opacity="0.6" />
                  <text x={4} y={y - 3} fontSize="8" fill={col} fontFamily="JetBrains Mono">
                    WALL {wall.px.toFixed(2)} {wall.domConfirmed ? '●' : ''}{wall.replenishConfirmed ? '◆' : ''}
                  </text>
                </g>
              );
            }) : [];


            // 4. ShiftCandle — triangle markers above/below bars at signal timestamps
            const shiftElems = showShiftCandle ? (window.OF_INDICATOR_MGR?.shiftCandle?.signals || []).slice(-20).map((sig, i) => {
              const xS = t2x(sig.ts);
              if (xS == null) return null;
              const bar = candles.find(c => c.time === sig.ts);
              const isBuy = sig.type === 'SHIFT_BUY';
              const refPx = isBuy ? (bar ? bar.l : sig.px) : (bar ? bar.h : sig.px);
              const y  = p2y(refPx);
              if (y == null) return null;
              const col = isBuy ? C.buy : C.sell;
              const pts = isBuy
                ? `${xS},${y+10} ${xS-5},${y+18} ${xS+5},${y+18}`
                : `${xS},${y-10} ${xS-5},${y-18} ${xS+5},${y-18}`;
              return <polygon key={'sh'+i} points={pts} fill={col} opacity="0.85" />;
            }) : [];

            // 5. DivergenceDetector — small D circles at swing pivot price/time
            const divElems = showDivergence ? (ind.divergenceDetector?.divergences || []).slice(-10).map((d, i) => {
              const xD = t2x(d.ts); const y = p2y(d.px);
              if (xD == null || y == null) return null;
              const col = d.type === 'BEARISH_DIVERGENCE' ? C.sell : C.buy;
              const yOff = d.type === 'BEARISH_DIVERGENCE' ? -14 : 14;
              return (
                <g key={'div'+i}>
                  <circle cx={xD} cy={y+yOff} r={6} fill={col} opacity="0.8" />
                  <text x={xD} y={y+yOff+3} textAnchor="middle" fontSize="8" fill={C.bg} fontWeight="700" fontFamily="JetBrains Mono">D</text>
                </g>
              );
            }) : [];

            return [...uaElems, ...wallElems, ...shiftElems, ...divElems];
          })()}

          {/* Stacked Imbalance Boxes (FVG style) */}
          {showStackedImb && chartRef.current && (() => {
            const boxes = [];
            candles.forEach((c, ci) => {
              const xStart = t2x(c.time);
              if (xStart == null || !c.stackedImb.length) return;
              c.stackedImb.forEach((st, si) => {
                const fLo = c.footprint[st.from];
                const fHi = c.footprint[st.to];
                if (!fLo || !fHi) return;
                const bodyLo = Math.min(c.o, c.c);
                const bodyHi = Math.max(c.o, c.c);
                const pxLo = Math.max(fLo.px, bodyLo);
                const pxHi = Math.min(fHi.px, bodyHi);
                if (pxHi <= pxLo) return;
                const yTop = p2y(pxHi);
                const yBot = p2y(pxLo);
                if (yTop == null || yBot == null || yBot <= yTop) return;
                const col = st.dir === 'ask' ? C.buy : C.sell;
                // Stretch to right edge; stop at first candle that trades into the zone
                let xEnd = xPxRight;
                for (let j = ci + 1; j < candles.length; j++) {
                  const nc = candles[j];
                  if (nc.l <= pxHi && nc.h >= pxLo) {
                    const xMit = t2x(nc.time);
                    if (xMit != null) xEnd = xMit + cellWBase / 2;
                    break;
                  }
                }
                const x = xStart + cellWBase / 2;
                const w = xEnd - x;
                if (w <= 0) return;
                // High-conviction (ask stack in upper third / bid stack in lower third):
                // brighter fill + thicker border
                boxes.push(
                  <rect key={`imb-${ci}-${si}`}
                    x={x} y={yTop} width={w} height={yBot - yTop}
                    fill={col} fillOpacity={st.highConv ? 0.14 : 0.06}
                    stroke={col} strokeWidth={st.highConv ? 1.5 : 0.8} strokeOpacity={st.highConv ? 0.75 : 0.4} />
                );
              });
            });
            return boxes;
          })()}

          {/* Markers */}
          {(showAbsorption || showExhaustion || showUFAMarks) && chartRef.current && (() => {
            const _ind = window.OF_INDICATORS || {};
            const openHighPxs = showUFAMarks ? new Set((_ind.unfinishedAuction?.openLevels || []).filter(l => l.type === 'HIGH').map(l => l.px)) : new Set();
            const openLowPxs  = showUFAMarks ? new Set((_ind.unfinishedAuction?.openLevels || []).filter(l => l.type === 'LOW').map(l => l.px))  : new Set();
            return candles.map((c) => {
            const xc = t2x(c.time);
            if (xc == null) return null;
            const cw = cellWBase;
            const yH = p2y(c.h), yL = p2y(c.l);
            return (
              <g key={'mk'+c.i}>
                {showAbsorption && c.absorption && yH != null && (
                  <g>
                    <circle cx={xc} cy={yH-9} r="4.5" fill={C.fg} />
                    <text x={xc} y={yH-6.5} fontSize="7" fill={C.bg} textAnchor="middle" fontWeight="700">A</text>
                  </g>
                )}
                {showExhaustion && c.exhaustion && c.delta > 0 && yH != null && (
                  <g>
                    <circle cx={xc} cy={yH-9} r="4.5" fill="oklch(72% 0.18 55)" />
                    <text x={xc} y={yH-6.5} fontSize="7" fill={C.bg} textAnchor="middle" fontWeight="700">X</text>
                  </g>
                )}
                {showExhaustion && c.exhaustion && c.delta < 0 && yL != null && (
                  <g>
                    <circle cx={xc} cy={yL+9} r="4.5" fill="oklch(72% 0.18 55)" />
                    <text x={xc} y={yL+11.5} fontSize="7" fill={C.bg} textAnchor="middle" fontWeight="700">X</text>
                  </g>
                )}
                {showUFAMarks && c.unfinishedHi && yH != null && openHighPxs.has(c.h) && (
                  <g>
                    <line x1={xc-cw/2-2} x2={xc+cw/2+2} y1={yH} y2={yH} stroke={C.sell} strokeWidth="1.5" strokeDasharray="1.2 1.2" />
                    <text x={xc+cw/2+4} y={yH+3} fontSize="8" fill={C.sell} fontFamily="JetBrains Mono">UFA</text>
                  </g>
                )}
                {showUFAMarks && c.unfinishedLo && yL != null && openLowPxs.has(c.l) && (
                  <g>
                    <line x1={xc-cw/2-2} x2={xc+cw/2+2} y1={yL} y2={yL} stroke={C.sell} strokeWidth="1.5" strokeDasharray="1.2 1.2" />
                    <text x={xc+cw/2+4} y={yL+3} fontSize="8" fill={C.sell} fontFamily="JetBrains Mono">UFA</text>
                  </g>
                )}
              </g>
            );
          });
          })()}

          {/* ── Large Print Circles ── */}
          {showLargePrints && chartRef.current && (() => {
            const lp = instrData.largeTrades || [];
            return lp.map((tr, i) => {
              if (!tr.barTime) return null;
              const x = t2x(tr.barTime);
              const y = p2y(tr.px);
              if (x == null || y == null) return null;
              const r = Math.max(5, Math.min(20, 4 + 3.5 * Math.log2(tr.size / 25 + 1)));
              const col = tr.side === 'buy' ? '#22d3ee' : '#f87171';
              const fillOp = tr.size >= 200 ? 0.22 : 0.14;
              return (
                <g key={'lp' + i}>
                  <circle cx={x} cy={y} r={r} fill={col} fillOpacity={fillOp} stroke={col} strokeWidth="1.2" strokeOpacity="0.75" />
                  {tr.size >= 100 && (
                    <text x={x} y={y + 3} textAnchor="middle" fontSize="8" fill={col} fontFamily="JetBrains Mono" fontWeight="600" opacity="0.9">{tr.size}</text>
                  )}
                </g>
              );
            });
          })()}

          {/* Drawings */}
          {/* ── GEX Levels (loaded from data/gex_levels.json) ── */}
          {showGex && chartRef.current && (() => {
            const chartSpot = lastBar?.close ?? candles[candles.length - 1]?.close ?? 0;
            return gexLevels.map((lvl, i) => {
              // Scale price proportionally if the level has a spot reference
              const displayPx = (lvl.spot && chartSpot)
                ? chartSpot * (lvl.price / lvl.spot)
                : lvl.price;
              const y = p2y(displayPx);
              if (y == null) return null;
              const midX = xPxRight / 2;
              const label = `${lvl.name}  ${lvl.price.toFixed(2)}`;
              const lblW = label.length * 6.4 + 10;
              return (
                <g key={'gex' + i}>
                  <line x1={0} x2={xPxRight} y1={y} y2={y}
                    stroke={lvl.color} strokeWidth="1" strokeDasharray="6 4" opacity="0.65" />
                  <rect x={midX - lblW / 2} y={y - 9} width={lblW} height={14}
                    fill={C.bg} fillOpacity="0.82" rx="2" />
                  <text x={midX} y={y + 3} fontSize="9.5" fontFamily="JetBrains Mono"
                    fontWeight="600" fill={lvl.color} textAnchor="middle">
                    {label}
                  </text>
                </g>
              );
            });
          })()}

          {chartRef.current && [...drawings, ...(pending ? [pending] : [])].map((d) => {
            const x1 = t2x(d.a.t), y1 = p2y(d.a.p);
            const x2 = t2x(d.b.t), y2 = p2y(d.b.p);
            if (x1 == null || y1 == null || x2 == null || y2 == null) return null;

            if (d.type === 'line') return (
              <g key={d.id}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.fg} strokeWidth="1.4" />
                <circle cx={x1} cy={y1} r="2.5" fill={C.fg} />
                <circle cx={x2} cy={y2} r="2.5" fill={C.fg} />
                <text x={x2+6} y={y2+3} fontSize="10" fontFamily="JetBrains Mono" fill={C.fg1}>{d.b.p.toFixed(2)}</text>
              </g>
            );

            if (d.type === 'hline') return (
              <g key={d.id}>
                <line x1={0} x2={xPxRight} y1={y1} y2={y1} stroke={C.fg} strokeWidth="1" strokeDasharray="3 3" />
                <rect x={xPxRight} y={y1-8} width={Math.min(56, W-xPxRight)} height={16} fill={C.panel} stroke={C.fg} strokeWidth="0.6" />
                <text x={xPxRight+28} y={y1+3} fontSize="10" fontFamily="JetBrains Mono" fontWeight="600" fill={C.fg} textAnchor="middle">{d.a.p.toFixed(2)}</text>
              </g>
            );

            if (d.type === 'box') {
              const xMin = Math.min(x1,x2), xMax = Math.max(x1,x2);
              const yMin = Math.min(y1,y2), yMax = Math.max(y1,y2);
              return (
                <g key={d.id}>
                  <rect x={xMin} y={yMin} width={xMax-xMin} height={yMax-yMin}
                    fill={C.fg} fillOpacity="0.06" stroke={C.fg} strokeWidth="1" strokeDasharray="3 3" />
                  <text x={xMin+4} y={yMin-4} fontSize="10" fontFamily="JetBrains Mono" fill={C.text}>
                    {Math.max(d.a.p, d.b.p).toFixed(2)} → {Math.min(d.a.p, d.b.p).toFixed(2)}
                  </text>
                </g>
              );
            }

            if (d.type === 'long' || d.type === 'short') {
              const isLong = d.type === 'long';
              const entry = d.a.p, tp = d.b.p;
              const sl = isLong ? entry - (tp - entry) : entry + (entry - tp);
              const yE = p2y(entry), yTp = p2y(tp), ySl = p2y(sl);
              if (yE == null || yTp == null || ySl == null) return null;
              const xMin = Math.min(x1,x2), xMax = Math.max(x1,x2);
              const tpCol = isLong ? C.buy : C.sell;
              const slCol = isLong ? C.sell : C.buy;
              const rr = Math.abs(tp - entry) / Math.max(0.01, Math.abs(entry - sl));
              const pnl = (tp - entry) * 50 * (isLong ? 1 : -1);
              return (
                <g key={d.id}>
                  <rect x={xMin} y={Math.min(yE,yTp)} width={xMax-xMin} height={Math.abs(yTp-yE)} fill={tpCol} fillOpacity="0.14" stroke={tpCol} strokeWidth="0.7" />
                  <rect x={xMin} y={Math.min(yE,ySl)} width={xMax-xMin} height={Math.abs(ySl-yE)} fill={slCol} fillOpacity="0.14" stroke={slCol} strokeWidth="0.7" />
                  <line x1={xMin} x2={xMax} y1={yE} y2={yE} stroke={C.fg} strokeWidth="1.4" />
                  <rect x={xMin+2} y={yE-13} width={44} height={13} fill={tpCol} rx="1.5" />
                  <text x={xMin+24} y={yE-3} fontSize="9" fontFamily="JetBrains Mono" fontWeight="700" fill={C.bg} textAnchor="middle">{isLong?'LONG':'SHORT'}</text>
                  <text x={xMax+5} y={yTp+4} fontSize="10" fontFamily="JetBrains Mono" fill={tpCol}>TP {tp.toFixed(2)}</text>
                  <text x={xMax+5} y={yE+4} fontSize="10" fontFamily="JetBrains Mono" fill={C.fg}>{entry.toFixed(2)}</text>
                  <text x={xMax+5} y={ySl+4} fontSize="10" fontFamily="JetBrains Mono" fill={slCol}>SL {sl.toFixed(2)}</text>
                  <text x={xMin+4} y={Math.max(yE,yTp,ySl)+14} fontSize="9.5" fontFamily="JetBrains Mono" fill={C.text}>
                    R:R 1:{rr.toFixed(2)} · {pnl>=0?'+':'−'}${Math.abs(pnl).toFixed(0)}/ct
                  </text>
                </g>
              );
            }

            if (d.type === 'text') return (
              <g key={d.id}>
                <circle cx={x1} cy={y1} r="2.5" fill={C.fg} />
                <text x={x1+6} y={y1-4} fontSize="11" fontFamily="Inter" fill={C.fg}>{d.label}</text>
              </g>
            );

            return null;
          })}
        </svg>

        {/* Drawing toolbar */}
        <div
          className="draw-toolbar"
          style={toolbarPos ? { left: toolbarPos.x, top: toolbarPos.y, bottom: 'auto' } : {}}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="draw-toolbar-grip" onMouseDown={onToolbarDragStart} title="Drag to move"><DrawIcons.grip /></div>
          <div className="sep" />
          {[['cursor','Cursor'],['line','Trend line'],['hline','Horizontal'],['box','Rectangle'],['long','Long position'],['short','Short position'],['text','Text note']].map(([k, title]) => {
            const Ico = DrawIcons[k];
            return (
              <button key={k} className={tool===k?'active':''} title={title} onClick={()=>setTool(k)}>
                <Ico />
              </button>
            );
          })}
          <div className="sep" />
          <button title="Undo" onClick={()=>setDrawings(d=>d.slice(0,-1))} disabled={drawings.length===0}><DrawIcons.undo /></button>
          <button className="danger" title="Clear all" onClick={()=>setDrawings([])} disabled={drawings.length===0}><DrawIcons.trash /></button>
        </div>

        {tool !== 'cursor' && (
          <div className="draw-status">
            <b>{tool==='long'?'Long':tool==='short'?'Short':tool[0].toUpperCase()+tool.slice(1)}</b>
            {tool==='hline' ? ' — click to place' : tool==='text' ? ' — click to add note' : ' — drag to draw'}
            {(tool==='long'||tool==='short') && ' (entry → target; SL mirrored)'}
          </div>
        )}

        <div className="chart-overlay">
          {lastBar && (
            <div className="legend mono">
              <span className="o">O <b>{lastBar.o.toFixed(2)}</b></span>
              <span className="h">H <b>{lastBar.h.toFixed(2)}</b></span>
              <span className="l">L <b>{lastBar.l.toFixed(2)}</b></span>
              <span className="c">C <b>{lastBar.c.toFixed(2)}</b></span>
              <span className="vol">VOL <b style={{color:C.fg1}}>{(lastBar.vol/1000).toFixed(1)}K</b></span>
              <span className="vol">Δ <b style={{color:lastBar.delta>=0?C.buy:C.sell}}>{lastBar.delta>=0?'+':''}{lastBar.delta}</b></span>
            </div>
          )}
          {(showAbsorption || showStackedImb || showUFAMarks) && (
            <div className="fp-legend-overlay">
              <span className="chip imb"><span className="sw" /> Imb{fps ? ` ≥${fps.thr.toFixed(1)}×` : ''}</span>
              <span className="chip imbs"><span className="sw" /> Stacked</span>
              <span className="chip abs"><span className="sw" /> Absorp</span>
              <span className="chip unf"><span className="sw" /> Unfin</span>
            </div>
          )}
        </div>

      </div>


    </div>
  );
}

window.ChartLW = ChartLW;
