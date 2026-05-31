// ============== Shared utilities ==============
const fmt = (n, d = 2) => Number(n).toFixed(d);
const fmtPx = (n) => n.toFixed(2);
const fmtSigned = (n) => (n >= 0 ? '+' : '') + n.toLocaleString();
const fmtK = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};

// ============== Sidebar (collapsible) ==============
const IconChevronLeft = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 3 L5 8 L10 13" />
  </svg>
);
const IconChevronRight = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3 L11 8 L6 13" />
  </svg>
);
const IconPlus = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M8 3v10M3 8h10" />
  </svg>
);
const IconSearch = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3 3" />
  </svg>
);
const IconLayout = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2" y="2" width="12" height="12" rx="1" />
    <path d="M2 6h12M6 6v8" />
  </svg>
);
const IconReplay = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8a5 5 0 1 0 1.5-3.5" />
    <path d="M3 2v3h3" />
  </svg>
);

function Sidebar({ open, onToggle, active, onSelect }) {
  const { watchlist } = window.OF_DATA;
  const flat = watchlist.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));

  return (
    <div className={'sidebar ' + (open ? 'open' : 'collapsed')}>
      <div className="sidebar-head">
        {open && <span className="title">Workspace</span>}
        <button className="sb-toggle" onClick={onToggle} title={open ? 'Collapse' : 'Expand'}>
          {open ? <IconChevronLeft /> : <IconChevronRight />}
        </button>
      </div>

      <div className="sb-actions">
        <button className="a" title="New watchlist"><IconPlus /><span>New watchlist</span></button>
        <button className="a" title="Search"><IconSearch /><span>Search symbols</span></button>
        <button className="a" title="Layouts"><IconLayout /><span>Layouts</span></button>
        <button className="a" title="Replay"><IconReplay /><span>Replay session</span></button>
      </div>

      <div className="sidebar-body">
        {open ? (
          watchlist.map((g) => (
            <div key={g.group}>
              <div className="wl-section">{g.group}</div>
              {g.items.map((it) => {
                const up = it.ch >= 0;
                return (
                  <div
                    key={it.sym}
                    className={'wl-row' + (active === it.sym ? ' active' : '')}
                    onClick={() => onSelect && onSelect(it.sym)}
                  >
                    <div>
                      <div className="sym">{it.sym}</div>
                      <div className="desc">{it.desc}</div>
                    </div>
                    <div className="px mono">{fmtPx(it.px)}</div>
                    <div className={'ch mono ' + (up ? 'up' : 'dn')}>
                      {up ? '+' : ''}{it.ch.toFixed(2)}%
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        ) : (
          <div className="wl-mini">
            {flat.map((it, i) => {
              const up = it.ch >= 0;
              const isLastInGroup = i < flat.length - 1 && flat[i + 1].group !== it.group;
              return (
                <React.Fragment key={it.sym}>
                  <div
                    className={'wl-mini-row' + (active === it.sym ? ' active' : '')}
                    onClick={() => onSelect && onSelect(it.sym)}
                    title={it.sym + ' · ' + it.desc}
                  >
                    <span className="s">{it.sym}</span>
                    <span className={'d ' + (up ? 'up' : 'dn')} />
                  </div>
                  {isLastInGroup && <div className="wl-mini-divider" />}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============== DOM Ladder ==============
function DOMLadder() {
  const { dom } = window.OF_DATA;
  const maxSize = Math.max(...dom.map((r) => Math.max(r.bid, r.ask)));
  return (
    <div className="panel p-dom">
      <div className="panel-h">
        <span className="title">Depth of Market</span>
        <span className="sep" />
        <span className="meta">21 LVL · 0.25 TICK</span>
        <span className="spacer" />
        <div className="seg">
          <button className="active">Size</button>
          <button>Orders</button>
        </div>
      </div>
      <div className="dom-head mono">
        <div style={{ textAlign: 'right' }}>BID×</div>
        <div style={{ textAlign: 'right' }}>BID</div>
        <div style={{ textAlign: 'center' }}>PRICE</div>
        <div>ASK</div>
        <div>×ASK</div>
      </div>
      <div className="dom-rows">
        {dom.map((r, i) => {
          const bidW = r.bid ? (r.bid / maxSize) * 50 : 0;
          const askW = r.ask ? (r.ask / maxSize) * 50 : 0;
          return (
            <div key={i} className={'dom-row' + (r.last ? ' last' : '')}>
              {r.bid ? <div className="bar bid" style={{ width: bidW + '%' }} /> : null}
              {r.ask ? <div className="bar ask" style={{ width: askW + '%' }} /> : null}
              <div className="col bidcum">{r.cumBid || ''}</div>
              <div className="col bidsize">{r.bid || ''}</div>
              <div className="col price">{fmtPx(r.px)}</div>
              <div className="col asksize">{r.ask || ''}</div>
              <div className="col askcum">{r.cumAsk || ''}</div>
              {r.last ? <span className="arrow">▶</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============== Time & Sales ==============
function TapePanel() {
  const { tape } = window.OF_DATA;
  const stats = window.OF_TAPE_STATS;
  const tps = (stats.velocity[stats.velocity.length - 1] || 0);
  const hotThr = stats.avgVelocity * 1.4;
  const buyPct = stats.aggressorPct;
  const sellPct = 1 - buyPct;

  // size histogram outlier threshold: last bin or beyond p97 visually
  const histMax = Math.max(...stats.histogram);

  return (
    <div className="panel p-tape">
      <div className="panel-h">
        <span className="title">Time &amp; Sales</span>
        <span className="sep" />
        <span className="meta">LAST {tape.length}</span>
        <span className="spacer" />
        <div className="seg">
          <button className="active">All</button>
          <button>Lg+</button>
          <button>Inst</button>
        </div>
      </div>

      <div className="tape-stats">
        <div className="row">
          <span className="lbl">Velocity</span>
          <div className="velocity">
            {stats.velocity.map((v, i) => {
              const h = Math.max(2, (v / Math.max(1, stats.maxVelocity)) * 100);
              const cls = 'b' + (v >= hotThr ? ' hot' : '') + (i === stats.velocity.length - 1 ? ' now' : '');
              return <div key={i} className={cls} style={{ height: h + '%' }} />;
            })}
          </div>
          <span className="val velocity-num">{tps}<span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>/s</span></span>
        </div>

        <div className="row">
          <span className="lbl">Aggressor</span>
          <div className="aggressor">
            <span className={'pct buy'}>{Math.round(buyPct * 100)}%</span>
            <div className="bar">
              <div className="b" style={{ width: (buyPct * 100) + '%' }} />
              <div className="s" style={{ width: (sellPct * 100) + '%' }} />
            </div>
            <span className={'pct sell'} style={{ textAlign: 'right' }}>{Math.round(sellPct * 100)}%</span>
          </div>
        </div>

        <div className="row">
          <span className="lbl">Sizes</span>
          <div className="sz-hist">
            {stats.histogram.map((v, i) => {
              const h = Math.max(2, (v / Math.max(1, histMax)) * 100);
              const outlier = i >= stats.histogram.length - 2 && v > 0;
              return <div key={i} className={'b' + (outlier ? ' outlier' : '')} style={{ height: h + '%' }} />;
            })}
          </div>
          <span className="val" style={{ minWidth: 32, textAlign: 'right' }}>n={tape.length}</span>
        </div>
      </div>

      <div className="tape-head">
        <div>TIME</div>
        <div style={{ textAlign: 'right' }}>PRICE</div>
        <div style={{ textAlign: 'right' }}>SIZE</div>
        <div style={{ textAlign: 'center' }}>×</div>
      </div>
      <div className="tape-rows">
        {tape.slice(0, 28).map((t, i) => {
          const cls = [
            'tape-row',
            t.side,
            'tier-' + t.tier,
            t.clusterLen >= 3 ? 'cluster' : '',
            t.clusterLen >= 6 ? 'cluster-strong' : '',
          ].filter(Boolean).join(' ');
          return (
            <div key={i} className={cls}>
              <div className="t">{t.time}</div>
              <div className="p">{fmtPx(t.px)}</div>
              <div className="s">{t.size}</div>
              <div className="clu">{t.clusterLen >= 3 ? '×' + t.clusterLen : ''}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============== TPO / Market Profile ==============
function TPO() {
  const { tpo } = window.OF_DATA;
  const ROWS = 22;
  const step = Math.max(1, Math.ceil(tpo.rows.length / ROWS));
  const display = [];
  for (let i = 0; i < tpo.rows.length; i += step) {
    const chunk = tpo.rows.slice(i, i + step);
    const letters = Array.from(new Set(chunk.flatMap((r) => r.letters)));
    const px = chunk[0].px;
    const poc = chunk.some((r) => r.poc);
    const va = chunk.some((r) => r.va);
    display.push({ px, letters, poc, va });
  }
  return (
    <div className="panel p-tpo">
      <div className="panel-h">
        <span className="title">TPO Profile</span>
        <span className="sep" />
        <span className="meta">30M · A–{tpo.periods[tpo.periods.length - 1].letter}</span>
        <span className="spacer" />
        <span className="meta">IB {fmtPx(tpo.ibLo)}–{fmtPx(tpo.ibHi)}</span>
      </div>
      <div className="tpo-wrap">
        <div className="tpo-axis">
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const idx = Math.round(p * (display.length - 1));
            return <div key={i}>{fmtPx(display[idx].px)}</div>;
          })}
        </div>
        <div className="tpo-grid">
          {display.map((r, i) => {
            const top = (i / display.length) * 100;
            const cls = 'row' + (r.poc ? ' poc' : '') + (r.va ? ' va' : '');
            return (
              <div key={i} className={cls} style={{ top: top + '%' }}>
                {r.letters.map((L, j) => {
                  let kls = 'cell';
                  if (r.poc && j === Math.floor(r.letters.length / 2)) kls += ' poc';
                  else if (r.va) kls += ' va';
                  return <div key={j} className={kls}>{L}</div>;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============== Cumulative Delta ==============
function DeltaPanel() {
  const { delta, sessionStats } = window.OF_DATA;
  const W = 1000, H = 100;
  const xStep = W / (delta.length - 1);
  const cumMax = Math.max(...delta.map((d) => d.cum));
  const cumMin = Math.min(...delta.map((d) => d.cum));
  const range = Math.max(Math.abs(cumMax), Math.abs(cumMin)) * 1.15 || 1;
  const yMid = H / 2;
  const yScale = (v) => yMid - (v / range) * (H / 2 - 4);
  const barMax = Math.max(...delta.map((d) => Math.abs(d.delta))) || 1;
  const barH = 24;
  const barY = H - barH - 2;
  const path = delta.map((d, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${yScale(d.cum).toFixed(1)}`).join(' ');

  return (
    <div className="panel p-delta">
      <div className="panel-h">
        <span className="title">Cumulative Delta</span>
        <span className="sep" />
        <span className="meta">SESSION</span>
        <span className="spacer" />
        <div className="delta-stats">
          <div className="s"><span className="k">Δ Session</span><span className={'v ' + (sessionStats.delta >= 0 ? 'pos' : 'neg')}>{fmtSigned(sessionStats.delta)}</span></div>
          <div className="s"><span className="k">Δ Last Bar</span><span className={'v ' + (delta[delta.length - 1].delta >= 0 ? 'pos' : 'neg')}>{fmtSigned(delta[delta.length - 1].delta)}</span></div>
          <div className="s"><span className="k">VWAP</span><span className="v mono">{fmtPx(sessionStats.vwap)}</span></div>
        </div>
      </div>
      <div className="delta-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <line x1={0} x2={W} y1={yMid} y2={yMid} stroke="var(--line)" strokeDasharray="2 3" />
          <line x1={0} x2={W} y1={barY - 2} y2={barY - 2} stroke="var(--line-soft)" />
          <path
            d={`${path} L ${(W).toFixed(1)},${yMid} L 0,${yMid} Z`}
            fill="url(#deltaGrad)"
            opacity="0.4"
          />
          <defs>
            <linearGradient id="deltaGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--buy)" stopOpacity="0.5" />
              <stop offset="50%" stopColor="var(--buy)" stopOpacity="0.05" />
              <stop offset="50%" stopColor="var(--sell)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--sell)" stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <path d={path} fill="none" stroke="var(--fg-0)" strokeWidth="1.4" />
          {delta.map((d, i) => {
            const h = Math.max(1, (Math.abs(d.delta) / barMax) * (barH - 2));
            const x = i * xStep - xStep * 0.4;
            const w = xStep * 0.8;
            const y = d.delta >= 0 ? barY + barH / 2 - h : barY + barH / 2;
            const fill = d.delta >= 0 ? 'var(--buy)' : 'var(--sell)';
            return <rect key={i} x={x} y={y} width={w} height={h} fill={fill} opacity="0.7" />;
          })}
          <line x1={0} x2={W} y1={barY + barH / 2} y2={barY + barH / 2} stroke="var(--line-soft)" />
          <text x={W - 4} y={12} fontSize="9" fill="var(--fg-3)" textAnchor="end" fontFamily="JetBrains Mono">+{Math.round(range)}</text>
          <text x={W - 4} y={yMid - 3} fontSize="9" fill="var(--fg-3)" textAnchor="end" fontFamily="JetBrains Mono">0</text>
          <text x={W - 4} y={barY - 6} fontSize="9" fill="var(--fg-3)" textAnchor="end" fontFamily="JetBrains Mono">−{Math.round(range)}</text>
        </svg>
      </div>
    </div>
  );
}

// ============== Large Trader Scanner ==============
function ScannerPanel() {
  const { largeTrades } = window.OF_DATA;
  return (
    <div className="panel p-scanner">
      <div className="panel-h">
        <span className="title">Large Trader Scanner</span>
        <span className="sep" />
        <span className="meta">UNUSUAL SIZE · LAST 30M</span>
        <span className="spacer" />
        <div className="seg">
          <button className="active">All</button>
          <button>Blocks</button>
          <button>Sweeps</button>
          <button>Icebergs</button>
        </div>
        <span className="sep" />
        <span className="meta">{largeTrades.length} hits</span>
      </div>
      <div className="scan-head scan-row">
        <div>TIME</div>
        <div>SYM</div>
        <div>TYPE</div>
        <div style={{ textAlign: 'right' }}>SIDE</div>
        <div style={{ textAlign: 'right' }}>SIZE</div>
        <div style={{ textAlign: 'right' }}>NOTIONAL</div>
        <div style={{ textAlign: 'right' }}>VENUE</div>
      </div>
      <div className="scan-rows" style={{ overflowY: 'auto' }}>
        {largeTrades.map((t, i) => (
          <div key={i} className="scan-row">
            <div className="time">{t.time}</div>
            <div className="sym">{t.sym}</div>
            <div><span className={'tag ' + t.type}>{t.type}</span></div>
            <div className={'side ' + t.side} style={{ textAlign: 'right' }}>
              {t.side === 'buy' ? 'BUY' : 'SELL'}
            </div>
            <div className="size">{t.size.toLocaleString()}</div>
            <div className="notional">${(t.notional).toFixed(0)}K</div>
            <div className="venue">{t.venue}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============== Chart (Candle / Footprint) ==============
Object.assign(window, { Sidebar, DOMLadder, TapePanel, TPO, DeltaPanel, ScannerPanel });
