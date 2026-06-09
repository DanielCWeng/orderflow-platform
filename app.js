const { useState, useEffect, useRef, useCallback } = React;

function BackfillButton() {
  const [state, setState] = React.useState('idle'); // idle | loading | ok | err
  const run = async () => {
    setState('loading');
    try {
      const r = await fetch('http://localhost:8000/backfill/run', { method: 'POST' });
      if (r.ok) {
        setState('ok');
        window.OF_RELOAD_OHLCV?.();
      } else {
        setState('err');
      }
    } catch { setState('err'); }
    setTimeout(() => setState('idle'), 3000);
  };
  const label = { idle: 'BF', loading: '…', ok: '✓ BF', err: '✗ BF' }[state];
  return (
    <button className={'ib-connect-btn gex-btn gex-' + state} onClick={run} disabled={state === 'loading'} title="Run yfinance backfill">
      {label}
    </button>
  );
}

function GexButton() {
  const [state, setState] = useState('idle'); // idle | loading | ok | err
  const run = async () => {
    setState('loading');
    try {
      const r = await fetch('http://localhost:8001/gex/run', { method: 'POST' });
      if (r.ok) {
        setState('ok');
        document.dispatchEvent(new CustomEvent('of-gex-update'));
      } else {
        setState('err');
      }
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

// ===== prefs persistence =====
const PREF_DEFAULTS = {
  active: 'ES',
  chartMode: 'bidask',
  showDelta: true, showImb: true,
  showDailyVP: true, showWeeklyVP: false, showVol: true,
  showAbsorption: true, showExhaustion: true, showStackedImb: true,
  showUFAMarks: true, showUFLines: true, showWalls: true,
  showShiftCandle: true, showDivergence: true, showLargePrints: true,
  showGex: true,
  sidebarOpen: true,
  deltaH: 190, scannerH: 47, domH: 300, signalsH: 140,
};
function loadPrefs() {
  try {
    const raw = localStorage.getItem('of-prefs');
    return raw ? { ...PREF_DEFAULTS, ...JSON.parse(raw) } : { ...PREF_DEFAULTS };
  } catch { return { ...PREF_DEFAULTS }; }
}
function savePrefs(p) {
  try { localStorage.setItem('of-prefs', JSON.stringify(p)); } catch {}
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

const INSTR_MAP = {
  ES:  { ticker: 'ESM26',  name: 'E-mini S&P 500 · Jun 2026' },
  NQ:  { ticker: 'NQM26',  name: 'E-mini Nasdaq 100 · Jun 2026' },
  YM:  { ticker: 'YMM26',  name: 'E-mini Dow · Jun 2026' },
  RTY: { ticker: 'RTYM26', name: 'E-mini Russell · Jun 2026' },
  CL:  { ticker: 'CLN26',  name: 'Crude Oil · Jul 2026' },
  NG:  { ticker: 'NGN26',  name: 'Natural Gas · Jul 2026' },
};

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

  const _p = loadPrefs();
  const [active, setActive] = useState(_p.active || 'ES');
  const [tf, setTf] = useState('5m');
  const [chartMode, setChartMode] = useState(_p.chartMode);
  const [showDelta, setShowDelta] = useState(_p.showDelta);
  const [showImb, setShowImb] = useState(_p.showImb);
  const [showDailyVP, setShowDailyVP] = useState(_p.showDailyVP);
  const [showWeeklyVP, setShowWeeklyVP] = useState(_p.showWeeklyVP);
  const [showVol, setShowVol] = useState(_p.showVol);
  const [showAbsorption,  setShowAbsorption]  = useState(_p.showAbsorption);
  const [showExhaustion,  setShowExhaustion]  = useState(_p.showExhaustion);
  const [showStackedImb,  setShowStackedImb]  = useState(_p.showStackedImb);
  const [showUFAMarks,    setShowUFAMarks]    = useState(_p.showUFAMarks);
  const [showUFLines,     setShowUFLines]     = useState(_p.showUFLines);
  const [showWalls,       setShowWalls]       = useState(_p.showWalls);
  const [showShiftCandle, setShowShiftCandle] = useState(_p.showShiftCandle);
  const [showDivergence,  setShowDivergence]  = useState(_p.showDivergence);
  const [showLargePrints, setShowLargePrints] = useState(_p.showLargePrints);
  const [showGex, setShowGex] = useState(_p.showGex);

  // sidebar
  const [sidebarOpen, setSidebarOpen] = useState(_p.sidebarOpen);

  // resizable row heights (px) for the bottom panels in each col-stack
  const [deltaH, setDeltaH] = useState(_p.deltaH);
  const [scannerH, setScannerH] = useState(_p.scannerH);
  const [domH, setDomH] = useState(_p.domH);
  const [signalsH, setSignalsH] = useState(_p.signalsH);
  // persist prefs on every change
  useEffect(() => {
    savePrefs({
      active,
      chartMode, showDelta, showImb, showDailyVP, showWeeklyVP, showVol,
      showAbsorption, showExhaustion, showStackedImb, showUFAMarks, showUFLines,
      showWalls, showShiftCandle, showDivergence, showLargePrints,
      showGex,
      sidebarOpen, deltaH, scannerH, domH, signalsH,
    });
  }, [active, chartMode, showDelta, showImb, showDailyVP, showWeeklyVP, showVol,
      showAbsorption, showExhaustion, showStackedImb, showUFAMarks, showUFLines,
      showWalls, showShiftCandle, showDivergence, showLargePrints,
      showGex,
      sidebarOpen, deltaH, scannerH, domH, signalsH]);

  // drag handlers
  const dragA1 = (e) => { // chart | delta
    const start = deltaH;
    startVerticalDrag(e, (dy) => setDeltaH(Math.max(90, Math.min(520, start - dy))));
  };
  const dragA2 = (e) => { // delta | scanner
    const startD = deltaH, startS = scannerH;
    startVerticalDrag(e, (dy) => {
      const newS = Math.max(47, Math.min(420, startS - dy));
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
          <BackfillButton />
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
          <span className="ticker">{INSTR_MAP[active]?.ticker ?? active}</span>
          <span className="name">{INSTR_MAP[active]?.name ?? active}</span>
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
          onSelect={(sym) => { setActive(sym); window.OF_SWITCH_INSTRUMENT?.(sym); }}
        />

        {/* Block A — chart / delta / scanner (all resizable) */}
        <div className="col-stack stack-mid">
          <div className="panel-slot flex">
            <ChartLW
              instrument={active}
              mode={chartMode} setMode={setChartMode}
              showDelta={showDelta} setShowDelta={setShowDelta}
              showImb={showImb} setShowImb={setShowImb}
              showDailyVP={showDailyVP} setShowDailyVP={setShowDailyVP}
              showWeeklyVP={showWeeklyVP} setShowWeeklyVP={setShowWeeklyVP}
              showVol={showVol} setShowVol={setShowVol}
              showAbsorption={showAbsorption}   setShowAbsorption={setShowAbsorption}
              showExhaustion={showExhaustion}   setShowExhaustion={setShowExhaustion}
              showStackedImb={showStackedImb}   setShowStackedImb={setShowStackedImb}
              showUFAMarks={showUFAMarks}       setShowUFAMarks={setShowUFAMarks}
              showUFLines={showUFLines}         setShowUFLines={setShowUFLines}
              showWalls={showWalls}             setShowWalls={setShowWalls}
showShiftCandle={showShiftCandle} setShowShiftCandle={setShowShiftCandle}
              showDivergence={showDivergence}   setShowDivergence={setShowDivergence}
              showLargePrints={showLargePrints} setShowLargePrints={setShowLargePrints}
              showGex={showGex} setShowGex={setShowGex}
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
        <span>Symbol: {INSTR_MAP[active]?.ticker ?? active}</span>
        <span>TF: {tf}</span>
        <span style={{ marginLeft: 'auto' }}>Account: PAPER-04231 · Equity $50,000.00 · P&L +$1,284.50</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
