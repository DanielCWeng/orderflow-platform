const { useState, useEffect, useRef, useCallback } = React;

function GexButton() {
  const [state, setState] = useState('idle'); // idle | loading | ok | err
  const run = async () => {
    setState('loading');
    try {
      const r = await fetch('http://localhost:8000/gex/run', { method: 'POST' });
      setState(r.ok ? 'ok' : 'err');
    } catch { setState('err'); }
    setTimeout(() => setState('idle'), 3000);
  };
  const label = { idle: 'GEX', loading: '…', ok: '✓ GEX', err: '✗ GEX' }[state];
  return (
    <button className={'ib-connect-btn gex-btn gex-' + state} onClick={run} disabled={state === 'loading'} title="Run GEX snapshot">
      {label}
    </button>
  );
}

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
  // Re-render whenever live data commits a new snapshot
  const [, setDataVersion] = useState(0);
  useEffect(() => {
    const onData = () => setDataVersion(v => v + 1);
    document.addEventListener('of-data-update', onData);
    return () => document.removeEventListener('of-data-update', onData);
  }, []);

  // Live connection status (from data-live.js)
  const [liveStatus, setLiveStatus] = useState(null);
  useEffect(() => {
    const onStatus = () => setLiveStatus(window._OF_LIVE_STATUS ? { ...window._OF_LIVE_STATUS } : null);
    document.addEventListener('of-status-update', onStatus);
    return () => document.removeEventListener('of-status-update', onStatus);
  }, []);

  const [active, setActive] = useState('ES');
  const [tf, setTf] = useState('5m');
  const [chartMode, setChartMode] = useState('bidask');
  const [showDelta, setShowDelta] = useState(true);
  const [showImb, setShowImb] = useState(true);
  const [showVP, setShowVP] = useState(true);
  const [showDailyVP, setShowDailyVP] = useState(true);
  const [showWeeklyVP, setShowWeeklyVP] = useState(false);
  const [showVol, setShowVol] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showIndOverlays, setShowIndOverlays] = useState(true);

  // sidebar
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // resizable row heights (px) for the bottom panels in each col-stack
  const [deltaH, setDeltaH] = useState(190);
  const [scannerH, setScannerH] = useState(170);
  const [domH, setDomH] = useState(300);
  const [signalsH, setSignalsH] = useState(140);
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
  const dragC1 = (e) => { // dom | tape
    const start = domH;
    startVerticalDrag(e, (dy) => setDomH(Math.max(180, Math.min(500, start + dy))));
  };
  const dragC2 = (e) => { // tape | signals
    const start = signalsH;
    startVerticalDrag(e, (dy) => setSignalsH(Math.max(80, Math.min(280, start - dy))));
  };

  const ss = window.OF_DATA.sessionStats;
  const last = window.OF_DATA.last ?? 0;
  const open = ss.open || last || 1;
  const chgAbs = last - open;
  const chgPct = open > 0 ? (chgAbs / open) * 100 : 0;
  const up = chgAbs >= 0;
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const localStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const localTz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName').value;
      const nycStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      setTime(`${localStr} ${localTz} · ${nycStr} ET`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

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
          <span className="pill"><span className="live" /> CME · LIVE</span>
          <span className="mono">{time}</span>
          <GexButton />
          <button
            className="ib-connect-btn"
            title="IronBeam connection"
            onClick={() => {
              const ov = document.getElementById('auth-overlay');
              if (ov) ov.style.display = ov.style.display === 'block' ? 'none' : 'block';
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 8a6 6 0 1 0 12 0A6 6 0 0 0 2 8Z" />
              <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {liveStatus?.ok ? 'IB' : 'Connect'}
          </button>
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
              showDailyVP={showDailyVP} setShowDailyVP={setShowDailyVP}
              showWeeklyVP={showWeeklyVP} setShowWeeklyVP={setShowWeeklyVP}
              showVol={showVol} setShowVol={setShowVol}
              showMarkers={showMarkers} setShowMarkers={setShowMarkers}
              showIndOverlays={showIndOverlays} setShowIndOverlays={setShowIndOverlays}
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

        {/* Block B — DOM / Tape / Signals (resizable) */}
        <div className="col-stack stack-dom">
          <div className="panel-slot" style={{ height: domH }}>
            <DOMLadder />
          </div>
          <div className="row-divider" onMouseDown={dragC1} title="Drag to resize" />
          <div className="panel-slot flex">
            <TapePanel />
          </div>
          <div className="row-divider" onMouseDown={dragC2} title="Drag to resize" />
          <div className="panel-slot" style={{ height: signalsH }}>
            <SignalsPanel />
          </div>
        </div>
      </div>

      {/* STATUS BAR */}
      <div className="statusbar">
        {liveStatus
          ? <span className={liveStatus.ok ? 'ok' : ''}>{liveStatus.ok ? '●' : '○'} {liveStatus.text}</span>
          : <span>○ Waiting for connection…</span>
        }
        <span>Feed: IronBeam · CME Globex</span>
        <span>Symbol: {active}H6</span>
        <span>TF: {tf}</span>
        <span style={{ marginLeft: 'auto' }}>Account: PAPER-04231 · Equity $50,000.00 · P&L +$1,284.50</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
