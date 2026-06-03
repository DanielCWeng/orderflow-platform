// ============== ChartLW — TradingView lightweight-charts ==============

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
        buyColor: '#aac9dc', sellColor: '#e9ab9b', bg: '#0e1116', fg: '#f3ecdb',
        priceLineVisible: false, lastValueVisible: false,
      };
    },
    priceValueBuilder(plotRow) {
      return [plotRow.low, plotRow.high];
    },
    isWhitespace(data) {
      return !data || !data.footprint || data.footprint.length === 0;
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
    showVP, setShowVP,
    showDailyVP, setShowDailyVP,
    showWeeklyVP, setShowWeeklyVP,
    showVol, setShowVol,
    showMarkers, setShowMarkers,
    showIndOverlays, setShowIndOverlays,
  } = props;

  const { candles, sessionStats, vp, dailyVP, weeklyVP } = window.OF_DATA;
  const [vpStripMode, setVpStripMode] = React.useState('session'); // 'session' | 'orderflow'
  const fps = window.OF_FOOTPRINT_STATS;
  const TICK = 0.25;
  const isFP = mode !== 'candle';

  const C = {
    bg:    '#0e1116',
    text:  '#8a8675',
    fg:    '#f3ecdb',
    fg1:   '#cbc4b3',
    line:  '#232a37',
    lineS: '#1c222d',
    panel: '#1a1f2a',
    buy:   '#aac9dc',
    sell:  '#e9ab9b',
    buyT:  'rgba(170, 201, 220, 0.55)',
    sellT: 'rgba(233, 171, 155, 0.55)',
  };

  const containerRef = React.useRef(null);
  const chartRef = React.useRef(null);
  const seriesRef = React.useRef(null);
  const volSeriesRef = React.useRef(null);
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
  const [pending, setPending] = React.useState(null);
  const [gexLevels, setGexLevels] = React.useState([]);

  // Fetch GEX levels file once on mount; silently ignore if not yet generated
  React.useEffect(() => {
    const load = () => {
      fetch('data/gex_levels.json?_=' + new Date().toDateString())
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.levels) setGexLevels(d.levels); })
        .catch(() => {});
    };
    load();
    // Refresh at midnight so the new day's levels are picked up automatically
    const msToMidnight = () => {
      const n = new Date();
      return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1) - n;
    };
    const tid = setTimeout(() => { load(); }, msToMidnight());
    return () => clearTimeout(tid);
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
    });
    vols.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      drawTicks: false,
      borderVisible: false,
      visible: false,
    });
    vols.setData(candles.map((c) => ({
      time: c.time,
      value: c.vol,
      color: c.delta >= 0 ? C.buyT : C.sellT,
    })));

    chartRef.current = chart;
    seriesRef.current = series;
    volSeriesRef.current = vols;

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
  }, [showVol]);

  // Track previous mode so we only reset barSpacing on candle↔FP transitions
  const prevModeRef = React.useRef(mode);
  // Footprint mode / overlays
  React.useEffect(() => {
    if (fpSeriesRef.current) {
      fpSeriesRef.current.applyOptions({ mode, showDelta, showImb });
    }
    // Hide main candlestick in FP mode — the custom renderer draws a thin candle instead
    if (seriesRef.current) {
      seriesRef.current.applyOptions({ visible: mode === 'candle' });
    }
    // Only reset barSpacing when crossing between candle and FP modes, not on every toggle
    if (chartRef.current) {
      const wasFP = prevModeRef.current !== 'candle';
      const isFPNow = mode !== 'candle';
      if (wasFP !== isFPNow) {
        chartRef.current.timeScale().applyOptions({ barSpacing: isFPNow ? 38 : 14 });
      }
      prevModeRef.current = mode;
    }
  }, [mode, showDelta, showImb]);

  // ---- sync series data whenever candles update ----
  React.useEffect(() => {
    if (!seriesRef.current || !candles.length) return;

    const prevCount = prevCandleCountRef.current;
    const newCount = candles.length;

    if (newCount !== prevCount) {
      // New bar added or bars reset — full setData
      seriesRef.current.setData(candles.map((c) => ({
        time: c.time, open: c.o, high: c.h, low: c.l, close: c.c,
      })));
      if (volSeriesRef.current) {
        volSeriesRef.current.setData(candles.map((c) => ({
          time: c.time, value: c.vol, color: c.delta >= 0 ? C.buyT : C.sellT,
        })));
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
        volSeriesRef.current.update({
          time: last.time, value: last.vol, color: last.delta >= 0 ? C.buyT : C.sellT,
        });
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
  }, [candles]);

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

  // ---- renderGroupedVP: daily/weekly VP on chart with zoom-dependent aggregation ----
  const renderGroupedVP = (vpEntries, colVA, colNon, prefix) => {
    if (!vpEntries?.length || !chartRef.current) return null;
    const out = [];
    const cellH = Math.max(1, pxPerTick - 0.5);
    const AGG_THRESH = 6; // barSpacing below this → aggregate

    for (let gi = 0; gi < vpEntries.length; gi++) {
      const g = vpEntries[gi];
      if (!g.rows?.length || !g.barTimes?.length) continue;

      const xs = g.barTimes.map(t => t2x(t)).filter(x => x != null);
      if (!xs.length) continue;

      const gxL = Math.min(...xs) - barSpacing / 2;
      const gxR = Math.max(...xs) + barSpacing / 2;

      if (barSpacing >= AGG_THRESH) {
        // --- Per-bar profiles (zoomed in) ---
        const timeSet = new Set(g.barTimes);
        for (const c of candles) {
          if (!timeSet.has(c.time)) continue;
          const xc = t2x(c.time);
          if (xc == null || !c.footprint?.length) continue;

          let bMax = 0;
          for (const f of c.footprint) { const t = f.bid + f.ask; if (t > bMax) bMax = t; }
          if (!bMax) continue;

          const xL = xc - barSpacing / 2;
          for (let fi = 0; fi < c.footprint.length; fi++) {
            const f = c.footprint[fi];
            const y = p2y(f.px);
            if (y == null) continue;
            const tot = f.bid + f.ask;
            if (!tot) continue;
            const w = (tot / bMax) * barSpacing;
            const va = f.px <= g.vah && f.px >= g.val;
            const poc = Math.abs(f.px - g.poc) < 0.13;
            out.push(<rect key={`${prefix}${gi}b${c.time}f${fi}`}
              x={xL} y={y - pxPerTick / 2 + 0.5} width={w} height={cellH}
              fill={va ? colVA : colNon} opacity={poc ? 0.7 : 0.35} />);
          }
        }
      } else {
        // --- Aggregated profile (zoomed out) ---
        const span = Math.max(4, gxR - gxL);
        const gMax = Math.max(1, ...g.rows.map(r => r.buy + r.sell));
        for (let ri = 0; ri < g.rows.length; ri++) {
          const r = g.rows[ri];
          const y = p2y(r.px);
          if (y == null) continue;
          const tot = r.buy + r.sell;
          const w = (tot / gMax) * span;
          out.push(<rect key={`${prefix}${gi}a${ri}`}
            x={gxL} y={y - pxPerTick / 2 + 0.5} width={w} height={cellH}
            fill={r.va ? colVA : colNon} opacity={r.poc ? 0.7 : 0.35} />);
        }
      }

      // POC / VAH / VAL reference lines spanning the group
      const lblPfx = prefix === 'dvp' ? '' : 'w';
      const yPoc = p2y(g.poc);
      if (yPoc != null) {
        out.push(<line key={`${prefix}${gi}Lpoc`} x1={gxL} x2={gxR} y1={yPoc} y2={yPoc}
          stroke={colVA} strokeWidth="1.2" strokeDasharray="6 3" opacity="0.5" />);
        out.push(<text key={`${prefix}${gi}Tpoc`} x={gxL - 4} y={yPoc + 3} fontSize="8"
          fill={colVA} textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">{lblPfx}POC</text>);
      }
      const yVah = p2y(g.vah);
      if (yVah != null) {
        out.push(<line key={`${prefix}${gi}Lvah`} x1={gxL} x2={gxR} y1={yVah} y2={yVah}
          stroke={colVA} strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />);
        out.push(<text key={`${prefix}${gi}Tvah`} x={gxL - 4} y={yVah + 3} fontSize="8"
          fill={colVA} textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">{lblPfx}VAH</text>);
      }
      const yVal = p2y(g.val);
      if (yVal != null) {
        out.push(<line key={`${prefix}${gi}Lval`} x1={gxL} x2={gxR} y1={yVal} y2={yVal}
          stroke={colVA} strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />);
        out.push(<text key={`${prefix}${gi}Tval`} x={gxL - 4} y={yVal + 3} fontSize="8"
          fill={colVA} textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">{lblPfx}VAL</text>);
      }
    }

    return out;
  };

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
  const vpMax = Math.max(1, ...vp.rows.map((r) => r.buy + r.sell));
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
          <button className={'toggle '+(showVP?'on':'')} onClick={()=>setShowVP(!showVP)}>VP</button>
          <button className={'toggle '+(showDailyVP?'on':'')} onClick={()=>setShowDailyVP(!showDailyVP)} title="Daily Volume Profile">DlyVP</button>
          <button className={'toggle '+(showWeeklyVP?'on':'')} onClick={()=>setShowWeeklyVP(!showWeeklyVP)} title="Weekly Volume Profile">WkVP</button>
          <button className={'toggle '+(showVol?'on':'')} onClick={()=>setShowVol(!showVol)}>Vol</button>
          <button className={'toggle '+(showMarkers?'on':'')} onClick={()=>setShowMarkers(!showMarkers)}>Marks</button>
          <button className={'toggle '+(showIndOverlays?'on':'')} onClick={()=>setShowIndOverlays(!showIndOverlays)} title="Indicator overlays">IND</button>
        </div>
        {showMarkers && fps && (<>
          <span className="sep" />
          <div className="fp-legend-inline">
            <span className="chip imb"><span className="sw" /> Imb ≥{fps.thr.toFixed(1)}×</span>
            <span className="chip imbs"><span className="sw" /> Stacked</span>
            <span className="chip abs"><span className="sw" /> Absorp</span>
            <span className="chip unf"><span className="sw" /> Unfin</span>
          </div>
        </>)}
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

          {/* ── Daily Volume Profile (on-chart, zoom-adaptive) ── */}
          {showDailyVP && renderGroupedVP(dailyVP, '#f0920a', '#eedd00', 'dvp')}

          {/* ── Weekly Volume Profile overlay (right side, bars point left) ── */}
          {showWeeklyVP && chartRef.current && weeklyVP && (() => {
            const wvp = weeklyVP[weeklyVP.length - 1];
            if (!wvp || !wvp.rows.length) return null;
            const wvpMax = Math.max(1, ...wvp.rows.map(r => r.buy + r.sell));
            const wvpWidth = Math.max(30, W * 0.05);
            const wvpX0 = xPxRight - wvpWidth;
            // Offset left if dailyVP is also visible so they don't overlap
            const offset = showDailyVP && dailyVP && dailyVP.length ? Math.max(30, W * 0.05) + 2 : 0;
            return (
              <g>
                {wvp.rows.map((r, i) => {
                  const y = p2y(r.px);
                  if (y == null) return null;
                  const total = r.buy + r.sell;
                  const w = (total / wvpMax) * wvpWidth;
                  const col = r.va ? '#7c3aed' : '#e9b8ff';
                  return (
                    <rect key={'wvp'+i} x={xPxRight - offset - w} y={y - 2} width={w} height={4} fill={col} opacity={r.poc ? 0.9 : 0.55} />
                  );
                })}
                {/* VAH line */}
                {(() => { const y = p2y(wvp.vah); return y != null ? (
                  <g>
                    <line x1={wvpX0 - offset} x2={xPxRight - offset} y1={y} y2={y} stroke="#c084fc" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                    <text x={wvpX0 - offset - 4} y={y + 3} fontSize="8" fill="#c084fc" textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">wVAH</text>
                  </g>
                ) : null; })()}
                {/* VAL line */}
                {(() => { const y = p2y(wvp.val); return y != null ? (
                  <g>
                    <line x1={wvpX0 - offset} x2={xPxRight - offset} y1={y} y2={y} stroke="#c084fc" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                    <text x={wvpX0 - offset - 4} y={y + 3} fontSize="8" fill="#c084fc" textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">wVAL</text>
                  </g>
                ) : null; })()}
                {/* POC line */}
                {(() => { const y = p2y(wvp.poc); return y != null ? (
                  <g>
                    <line x1={wvpX0 - offset} x2={xPxRight - offset} y1={y} y2={y} stroke="#a855f7" strokeWidth="1.2" strokeDasharray="6 3" opacity="0.4" />
                    <text x={wvpX0 - offset - 4} y={y + 3} fontSize="8" fill="#a855f7" textAnchor="end" fontFamily="JetBrains Mono" opacity="0.7">wPOC</text>
                  </g>
                ) : null; })()}
              </g>
            );
          })()}

          {/* ── Indicator Overlays ── */}
          {showIndOverlays && chartRef.current && (() => {
            const ind = window.OF_INDICATORS || {};

            // 1. UnfinishedAuction — dashed horizontal lines at open levels
            const uaLevels = ind.unfinishedAuction?.openLevels || [];
            const uaElems = uaLevels.map((lvl, i) => {
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
            });

            // 2. DeepWall — solid horizontal lines at active wall prices
            const walls = ind.deepWall?.activeWalls || [];
            const wallElems = walls.map((wall, i) => {
              const y = p2y(wall.px);
              if (y == null) return null;
              const col = wall.side === 'ASK' ? C.sell : C.buy;
              const sw  = wall.domConfirmed ? 2 : 1;
              return (
                <g key={'wall'+i}>
                  <line x1={0} x2={xPxRight} y1={y} y2={y} stroke={col} strokeWidth={sw} opacity="0.6" />
                  <text x={4} y={y - 3} fontSize="8" fill={col} fontFamily="JetBrains Mono">
                    WALL {wall.px.toFixed(2)} {wall.domConfirmed ? '●' : ''}
                  </text>
                </g>
              );
            });

            // 3. ImbalanceTracker — semi-transparent zone bands extending right from bar start
            const freshZones    = ind.imbalanceTracker?.freshZones    || [];
            const triggeredZones= ind.imbalanceTracker?.triggeredZones || [];
            const zoneElems = [
              ...freshZones.map((z, i) => {
                const xZ = t2x(z.ts); const y = p2y(z.px);
                if (xZ == null || y == null) return null;
                const col = z.side === 'ASK' ? C.buy : C.sell;
                return <rect key={'fz'+i} x={xZ} y={y-1.5} width={Math.max(0, xPxRight-xZ)} height={3} fill={col} opacity="0.18" />;
              }),
              ...triggeredZones.map((z, i) => {
                const xZ = t2x(z.ts); const y = p2y(z.px);
                if (xZ == null || y == null) return null;
                const col = z.side === 'ASK' ? C.buy : C.sell;
                return <rect key={'tz'+i} x={xZ} y={y-1.5} width={Math.max(0, xPxRight-xZ)} height={3} fill={col} opacity="0.07" strokeDasharray="2 2" />;
              }),
            ];

            // 4. ShiftCandle — triangle markers above/below bars at signal timestamps
            const shiftSigs = (window.OF_INDICATOR_MGR?.shiftCandle?.signals || []).slice(-20);
            const shiftElems = shiftSigs.map((sig, i) => {
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
            });

            // 5. DivergenceDetector — small D circles at swing pivot price/time
            const divs = ind.divergenceDetector?.divergences || [];
            const divElems = divs.slice(-10).map((d, i) => {
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
            });

            return [...uaElems, ...wallElems, ...zoneElems, ...shiftElems, ...divElems];
          })()}

          {/* Markers */}
          {showMarkers && chartRef.current && candles.map((c) => {
            const xc = t2x(c.time);
            if (xc == null) return null;
            const cw = cellWBase;
            const yH = p2y(c.h), yL = p2y(c.l);
            return (
              <g key={'mk'+c.i}>
                {c.stackedImb.map((st, si) => {
                  const f0 = c.footprint[st.from];
                  const f1 = c.footprint[st.to];
                  const y0 = p2y(f1.px), y1 = p2y(f0.px);
                  if (y0 == null || y1 == null) return null;
                  const col = st.dir === 'ask' ? C.buy : C.sell;
                  const xb = xc + cw/2 + 2.5;
                  return (
                    <g key={si}>
                      <line x1={xb} x2={xb} y1={y0-4} y2={y1+4} stroke={col} strokeWidth="1.6" />
                      <line x1={xb-2.5} x2={xb+2.5} y1={y0-4} y2={y0-4} stroke={col} strokeWidth="1.2" />
                      <line x1={xb-2.5} x2={xb+2.5} y1={y1+4} y2={y1+4} stroke={col} strokeWidth="1.2" />
                    </g>
                  );
                })}
                {c.absorption && yH != null && (
                  <g>
                    <circle cx={xc} cy={yH-9} r="4.5" fill={C.fg} />
                    <text x={xc} y={yH-6.5} fontSize="7" fill={C.bg} textAnchor="middle" fontWeight="700">A</text>
                  </g>
                )}
                {c.unfinishedHi && yH != null && (
                  <g>
                    <line x1={xc-cw/2-2} x2={xc+cw/2+2} y1={yH} y2={yH} stroke={C.sell} strokeWidth="1.5" strokeDasharray="1.2 1.2" />
                    <text x={xc+cw/2+4} y={yH+3} fontSize="8" fill={C.sell} fontFamily="JetBrains Mono">UFA</text>
                  </g>
                )}
                {c.unfinishedLo && yL != null && (
                  <g>
                    <line x1={xc-cw/2-2} x2={xc+cw/2+2} y1={yL} y2={yL} stroke={C.sell} strokeWidth="1.5" strokeDasharray="1.2 1.2" />
                    <text x={xc+cw/2+4} y={yL+3} fontSize="8" fill={C.sell} fontFamily="JetBrains Mono">UFA</text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Drawings */}
          {/* ── GEX Levels (loaded from data/gex_levels.json) ── */}
          {chartRef.current && gexLevels.map((lvl, i) => {
            const y = p2y(lvl.price);
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
          })}

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
        <div className="draw-toolbar" onMouseDown={(e) => e.stopPropagation()}>
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
        </div>

      </div>

      {/* VP strip below chart */}
      {showVP && (() => {
        const VP_H = 48;
        const stripW = xPxRight;

        // Session VP — horizontal histogram by price
        const sessionContent = vp.rows.length > 0 && (() => {
          const prices = vp.rows.map(r => r.px);
          const pxMin = Math.min(...prices);
          const pxMax = Math.max(...prices);
          const pxRange = pxMax - pxMin || 1;
          const barW = Math.max(1, (stripW / vp.rows.length) * 0.85);
          const px2x = (px) => ((px - pxMin) / pxRange) * (stripW - barW);
          return (
            <>
              {vp.rows.map((r, i) => {
                const total = r.buy + r.sell;
                const x = px2x(r.px);
                const h = (total / vpMax) * (VP_H - 4);
                const buyH = total > 0 ? (r.buy / total) * h : 0;
                const sellH = h - buyH;
                const op = r.poc ? 0.85 : 0.5;
                return (
                  <g key={'vps'+i}>
                    <rect x={x} y={VP_H - h} width={barW} height={sellH} fill={C.sell} opacity={op} />
                    <rect x={x} y={VP_H - buyH} width={barW} height={buyH} fill={C.buy} opacity={op} />
                    {r.poc && <line x1={x} x2={x+barW} y1={VP_H - h - 1} y2={VP_H - h - 1} stroke={C.fg1} strokeWidth="1.5" />}
                  </g>
                );
              })}
              <text x={4} y={VP_H - 4} fontSize="7.5" fill={C.fg} fontFamily="JetBrains Mono" opacity="0.35">{Math.min(...vp.rows.map(r=>r.px)).toFixed(2)}</text>
              <text x={stripW - 4} y={VP_H - 4} fontSize="7.5" fill={C.fg} fontFamily="JetBrains Mono" opacity="0.35" textAnchor="end">{Math.max(...vp.rows.map(r=>r.px)).toFixed(2)}</text>
            </>
          );
        })();

        // Orderflow VP — per-bar volume columns aligned with chart time axis
        const ofContent = candles.length > 0 && chartRef.current && (() => {
          const volMax = Math.max(1, ...candles.map(c => c.vol));
          return candles.map((c, i) => {
            const xc = t2x(c.time);
            if (xc == null) return null;
            const bw = Math.max(2, barSpacing * 0.7);
            const h = (c.vol / volMax) * (VP_H - 4);
            const buyPct = c.vol > 0 ? c.ask / (c.ask + c.bid || 1) : 0.5;
            const buyH = h * buyPct;
            const sellH = h - buyH;
            return (
              <g key={'ofv'+i}>
                <rect x={xc - bw/2} y={VP_H - h} width={bw} height={sellH} fill={C.sell} opacity="0.55" />
                <rect x={xc - bw/2} y={VP_H - buyH} width={bw} height={buyH} fill={C.buy} opacity="0.55" />
              </g>
            );
          });
        })();

        return (
          <div className="vp-strip" style={{ height: VP_H, flexShrink:0, position:'relative', borderTop:'1px solid '+C.line, background: C.bg }}>
            <div className="vp-strip-tabs" style={{
              position:'absolute', top:2, left:4, display:'flex', gap:1, zIndex:2,
              background: C.panel, borderRadius:3, padding:1,
              fontFamily:'JetBrains Mono', fontSize:'8px', textTransform:'uppercase', letterSpacing:'0.05em',
            }}>
              <button
                onClick={()=>setVpStripMode('session')}
                style={{ all:'unset', cursor:'pointer', padding:'2px 5px', borderRadius:2,
                  background: vpStripMode==='session' ? C.line : 'transparent',
                  color: vpStripMode==='session' ? C.fg1 : C.fg+'80',
                }}
              >Session</button>
              <button
                onClick={()=>setVpStripMode('orderflow')}
                style={{ all:'unset', cursor:'pointer', padding:'2px 5px', borderRadius:2,
                  background: vpStripMode==='orderflow' ? C.line : 'transparent',
                  color: vpStripMode==='orderflow' ? C.fg1 : C.fg+'80',
                }}
              >Orderflow</button>
            </div>
            <svg width={W} height={VP_H} style={{ display:'block' }}>
              {vpStripMode === 'session' ? sessionContent : ofContent}
            </svg>
          </div>
        );
      })()}

    </div>
  );
}

window.ChartLW = ChartLW;
