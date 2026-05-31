const { useState, useEffect, useRef, useCallback } = React;

// ===== drag helper =====
function startVerticalDrag(e, onMove) {
  e.preventDefault();
  const startY = e.clientY;
  const target = e.currentTarget;
  target.classList.add('dragging');
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
  const move = (ev) => onMove(ev.clientY - startY);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    target.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function App() {
  const [density, setDensity] = useState('balanced');
  const [active, setActive] = useState('ES');
  const [tf, setTf] = useState('5m');
  const [chartMode, setChartMode] = useState('bidask');
  const [showDelta, setShowDelta] = useState(true);
  const [showImb, setShowImb] = useState(true);
  const [showVP, setShowVP] = useState(true);
  const [showVol, setShowVol] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);

  // sidebar
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // resizable row heights (px) for the bottom panels in each col-stack
  const [deltaH, setDeltaH] = useState(190);
  const [scannerH, setScannerH] = useState(170);
  const [tpoH, setTpoH] = useState(220);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);

  // drag handlers
  const dragA1 = (e) => { // chart | delta
    const start = deltaH;
    startVerticalDrag(e, (dy) => setDeltaH(Math.max(90, Math.min(520, start - dy))));
  };
  const dragA2 = (e) => { // delta | scanner
    const startD = deltaH, startS = scannerH;
    startVerticalDrag(e, (dy) => {
      const newS = Math.max(80, Math.min(420, startS - dy));
      const realDy = startS - newS;
      setScannerH(newS);
      setDeltaH(Math.max(90, Math.min(520, startD + realDy)));
    });
  };
  const dragB1 = (e) => { // tape | tpo
    const start = tpoH;
    startVerticalDrag(e, (dy) => setTpoH(Math.max(100, Math.min(520, start - dy))));
  };

  const ss = window.OF_DATA.sessionStats;
  const last = window.OF_DATA.last;
  const open = ss.open;
  const chgAbs = last - open;
  const chgPct = (chgAbs / open) * 100;
  const up = chgAbs >= 0;
  const time = '14:32:18 ET';

  return (
    <div className="app" data-screen-label="01 Orderflow">
      {/* TOP BAR */}
      <div className="topbar">
        <div className="brand">
          <div className="dot" />
          <span>ORDERFLOW</span>
          <small>v0.4 · paper</small>
        </div>
        <nav className="topnav">
          <a className="active" href="#">Workstation</a>
          <a href="#">Scanner</a>
          <a href="#">Replay</a>
          <a href="#">Strategies</a>
          <a href="#">Journal</a>
        </nav>
        <div className="topbar-right">
          <div className="density-toggle" role="tablist" aria-label="density">
            {['compact', 'balanced', 'spacious'].map((d) => (
              <button key={d} className={d === density ? 'active' : ''} onClick={() => setDensity(d)}>
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
          <span className="pill"><span className="live" /> CME · LIVE</span>
          <span className="mono">{time}</span>
        </div>
      </div>

      {/* SUB BAR */}
      <div className="subbar">
        <div className="symbol">
          <span className="ticker">{active}H6</span>
          <span className="name">E-mini S&P 500 · Mar 2026</span>
        </div>
        <span className="last mono">{last.toFixed(2)}</span>
        <span className={'chg ' + (up ? 'up' : 'dn')}>{up ? '+' : ''}{chgAbs.toFixed(2)} · {up ? '+' : ''}{chgPct.toFixed(2)}%</span>
        <div className="stat"><span className="k">Open</span><span className="v">{ss.open.toFixed(2)}</span></div>
        <div className="stat"><span className="k">High</span><span className="v">{ss.high.toFixed(2)}</span></div>
        <div className="stat"><span className="k">Low</span><span className="v">{ss.low.toFixed(2)}</span></div>
        <div className="stat"><span className="k">VWAP</span><span className="v">{ss.vwap.toFixed(2)}</span></div>
        <div className="stat"><span className="k">Volume</span><span className="v">{(ss.volume / 1000).toFixed(1)}K</span></div>
        <div className="stat"><span className="k">Δ Session</span>
          <span className="v" style={{ color: ss.delta >= 0 ? 'var(--buy)' : 'var(--sell)' }}>
            {ss.delta >= 0 ? '+' : ''}{ss.delta.toLocaleString()}
          </span>
        </div>
        <div className="tf-group" role="tablist" aria-label="timeframe">
          {['1m', '5m', '15m', '30m', '1H', '4H', 'D'].map((t) => (
            <button key={t} className={t === tf ? 'active' : ''} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
      </div>

      {/* MAIN */}
      <div className="main">
        <Sidebar
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
          active={active}
          onSelect={setActive}
        />

        {/* Block A — chart / delta / scanner (all resizable) */}
        <div className="col-stack stack-mid">
          <div className="panel-slot flex">
            <ChartLW
              mode={chartMode} setMode={setChartMode}
              showDelta={showDelta} setShowDelta={setShowDelta}
              showImb={showImb} setShowImb={setShowImb}
              showVP={showVP} setShowVP={setShowVP}
              showVol={showVol} setShowVol={setShowVol}
              showMarkers={showMarkers} setShowMarkers={setShowMarkers}
            />
          </div>
          <div className="row-divider" onMouseDown={dragA1} title="Drag to resize" />
          <div className="panel-slot" style={{ height: deltaH }}>
            <DeltaPanel />
          </div>
          <div className="row-divider" onMouseDown={dragA2} title="Drag to resize" />
          <div className="panel-slot" style={{ height: scannerH }}>
            <ScannerPanel />
          </div>
        </div>

        {/* Block B — tape / tpo (resizable) */}
        <div className="col-stack stack-tape">
          <div className="panel-slot flex">
            <TapePanel />
          </div>
          <div className="row-divider" onMouseDown={dragB1} title="Drag to resize" />
          <div className="panel-slot" style={{ height: tpoH }}>
            <TPO />
          </div>
        </div>

        {/* Block C — DOM (fixed, full height) */}
        <div className="col-stack stack-dom">
          <div className="panel-slot flex">
            <DOMLadder />
          </div>
        </div>
      </div>

      {/* STATUS BAR */}
      <div className="statusbar">
        <span className="ok">● Connected</span>
        <span>Latency 8ms</span>
        <span>Feed: CME Globex</span>
        <span>Symbol: {active}H6</span>
        <span>TF: {tf}</span>
        <span>Density: {density}</span>
        <span style={{ marginLeft: 'auto' }}>Account: PAPER-04231 · Equity $50,000.00 · P&L +$1,284.50</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
