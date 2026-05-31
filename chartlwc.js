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
  const renderer = {
    _data: null,
    _opts: null,
    draw(target, priceConverter) {
      const data = this._data, opts = this._opts;
      if (!data || !opts || opts.mode === 'candle') return;
      target.useMediaCoordinateSpace((scope) => {
        const ctx = scope.context;
        const bars = data.bars;
        if (!bars || bars.length < 2) return;

        let barSpacing = 14;
        for (let i = 1; i < Math.min(bars.length, 10); i++) {
          const dx = bars[i].x - bars[i - 1].x;
          if (dx > 0) { barSpacing = dx; break; }
        }
        const cellW = Math.max(2, barSpacing * 0.86);
        const cellH = Math.min(12, Math.max(6, barSpacing * 0.55));
        const tFont = cellH < 9 ? 6 : 6.8;
        const { mode, showDelta, showImb, buyColor, sellColor } = opts;

        ctx.font = `${tFont}px 'JetBrains Mono', ui-monospace, monospace`;
        ctx.textBaseline = 'middle';

        for (const bar of bars) {
          const fp = bar.originalData.footprint;
          if (!fp || !fp.length) continue;
          const rowMax = Math.max(...fp.map((f) => Math.max(f.bid, f.ask)));
          const rowTotalMax = Math.max(...fp.map((f) => f.bid + f.ask));

          for (const f of fp) {
            const y = priceConverter(f.px);
            if (y == null) continue;
            const yT = y - cellH / 2;
            const xL = bar.x - cellW / 2;
            const dl = f.ask - f.bid;
            const rowTotal = f.bid + f.ask;

            if (mode === 'bidask') {
              const askA = Math.min(0.55, 0.06 + (f.ask / Math.max(1, rowMax)) * 0.5);
              const bidA = Math.min(0.55, 0.06 + (f.bid / Math.max(1, rowMax)) * 0.5);
              ctx.globalAlpha = bidA;
              ctx.fillStyle = sellColor;
              ctx.fillRect(xL, yT, cellW / 2, cellH - 1);
              ctx.globalAlpha = askA;
              ctx.fillStyle = buyColor;
              ctx.fillRect(bar.x, yT, cellW / 2, cellH - 1);
              ctx.globalAlpha = 1;
            } else if (mode === 'profile') {
              const w = (rowTotal / Math.max(1, rowTotalMax)) * cellW;
              ctx.globalAlpha = 0.55;
              ctx.fillStyle = dl >= 0 ? buyColor : sellColor;
              ctx.fillRect(xL, yT + 1, w, cellH - 2);
              ctx.globalAlpha = 1;
            }

            if (showDelta && cellW > 13) {
              ctx.fillStyle = dl >= 0 ? buyColor : sellColor;
              ctx.textAlign = 'center';
              ctx.fillText((dl >= 0 ? '+' : '') + dl, bar.x, yT + cellH / 2);
            } else if (mode === 'bidask' && cellW > 22) {
              ctx.fillStyle = sellColor;
              ctx.textAlign = 'right';
              ctx.fillText(f.bid, bar.x - 1, yT + cellH / 2);
              ctx.fillStyle = buyColor;
              ctx.textAlign = 'left';
              ctx.fillText(f.ask, bar.x + 1, yT + cellH / 2);
            }

            if (showImb && (f.askImb || f.bidImb)) {
              ctx.globalAlpha = 1;
              ctx.strokeStyle = f.askImb ? buyColor : sellColor;
              ctx.lineWidth = 1.2;
              ctx.strokeRect(xL + 0.5, yT + 0.5, cellW - 1, cellH - 2);
            }
          }
        }
      });
    },
  };

  return {
    _r: renderer,
    defaultOptions() {
      return {
        mode: 'bidask', showDelta: true, showImb: true,
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
    showVol, setShowVol,
    showMarkers, setShowMarkers,
  } = props;

  const { candles, sessionStats, vp } = window.OF_DATA;
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

  const [, forceRender] = React.useReducer((x) => (x + 1) % 1e9, 0);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [psWidth, setPsWidth] = React.useState(60);

  const [tool, setTool] = React.useState('cursor');
  const [drawings, setDrawings] = React.useState([]);
  const [pending, setPending] = React.useState(null);

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
    series.createPriceLine({
      price: sessionStats.vwap, color: C.text, lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: 'VWAP',
    });
    series.createPriceLine({
      price: vp.poc, color: C.buy, lineWidth: 1,
      lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'POC',
    });

    const vols = chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
    });
    vols.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
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
        time: c.time, low: c.l, high: c.h, footprint: c.footprint,
      })));
      fpSeriesRef.current = fpSeries;
    } catch (e) {
      console.warn('Custom Series unavailable', e);
    }

    chart.timeScale().applyOptions({ barSpacing: props.mode === 'candle' ? 14 : 38 });

    const forceDraw = () => { try { chart.takeScreenshot(); } catch (e) {} };
    forceDraw();
    requestAnimationFrame(forceDraw);
    setTimeout(forceDraw, 150);

    chart.timeScale().fitContent();

    const onChange = () => {
      try { setPsWidth(chart.priceScale('right').width()); } catch (e) {}
      forceRender();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onChange);
    chart.subscribeCrosshairMove(onChange);

    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      try { chart.resize(width, height); } catch (e) {}
      setSize({ w: width, h: height });
      try { setPsWidth(chart.priceScale('right').width()); } catch (e) {}
      forceDraw();
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
    if (!volSeriesRef.current || !chartRef.current) return;
    volSeriesRef.current.applyOptions({ visible: showVol });
    chartRef.current.priceScale('right').applyOptions({
      scaleMargins: { top: 0.06, bottom: showVol ? 0.22 : 0.05 },
    });
  }, [showVol]);

  // Footprint mode / overlays
  React.useEffect(() => {
    if (fpSeriesRef.current) {
      fpSeriesRef.current.applyOptions({ mode, showDelta, showImb });
    }
    if (chartRef.current) {
      chartRef.current.timeScale().applyOptions({ barSpacing: mode === 'candle' ? 14 : 38 });
      try { chartRef.current.takeScreenshot(); } catch (e) {}
    }
  }, [mode, showDelta, showImb]);

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
          <button className={'toggle '+(showVol?'on':'')} onClick={()=>setShowVol(!showVol)}>Vol</button>
          <button className={'toggle '+(showMarkers?'on':'')} onClick={()=>setShowMarkers(!showMarkers)}>Marks</button>
        </div>
      </div>

      <div className="chart-canvas">
        <div ref={containerRef} style={{ position:'absolute', inset:0 }} />

        <svg
          width={W} height={H}
          style={{
            position:'absolute', inset:0,
            pointerEvents: tool === 'cursor' ? 'none' : 'auto',
            cursor: tool !== 'cursor' ? 'crosshair' : 'default',
          }}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={() => { if (pending) setPending(null); }}
        >
          {/* VP overlay */}
          {showVP && chartRef.current && vp.rows.map((r, i) => {
            const y = p2y(r.px);
            if (y == null) return null;
            const total = r.buy + r.sell;
            const w = (total / vpMax) * vpWidth;
            const buyW = (r.buy / vpMax) * vpWidth;
            return (
              <g key={'vp'+i}>
                <rect x={xPxRight - w} y={y - 1.2} width={w - buyW} height={2.4} fill={C.sell} opacity={r.poc ? 0.55 : 0.30} />
                <rect x={xPxRight - buyW} y={y - 1.2} width={buyW} height={2.4} fill={C.buy} opacity={r.poc ? 0.60 : 0.34} />
              </g>
            );
          })}

          {/* Markers */}
          {isFP && showMarkers && chartRef.current && candles.map((c) => {
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
          <div className="legend mono">
            <span className="o">O <b>{lastBar.o.toFixed(2)}</b></span>
            <span className="h">H <b>{lastBar.h.toFixed(2)}</b></span>
            <span className="l">L <b>{lastBar.l.toFixed(2)}</b></span>
            <span className="c">C <b>{lastBar.c.toFixed(2)}</b></span>
            <span className="vol">VOL <b style={{color:C.fg1}}>{(lastBar.vol/1000).toFixed(1)}K</b></span>
            <span className="vol">Δ <b style={{color:lastBar.delta>=0?C.buy:C.sell}}>{lastBar.delta>=0?'+':''}{lastBar.delta}</b></span>
          </div>
        </div>

        {isFP && showMarkers && fps && (
          <div className="fp-legend">
            <span className="chip imb"><span className="sw" /> Imbalance ≥{fps.thr.toFixed(1)}×</span>
            <span className="chip imbs"><span className="sw" /> Stacked 3+</span>
            <span className="chip abs"><span className="sw" /> Absorption</span>
            <span className="chip unf"><span className="sw" /> Unfinished</span>
          </div>
        )}
      </div>
    </div>
  );
}

window.ChartLW = ChartLW;
