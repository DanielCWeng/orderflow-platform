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
  const { dom, domExec, domSessionDelta } = window.OF_DATA;
  const maxSize = Math.max(1, ...dom.map((r) => Math.max(r.bid, r.ask)));
  const lastIdx = dom.findIndex(r => r.last);
  const anchorIdx = lastIdx >= 0 ? lastIdx : Math.floor(dom.length / 2);

  return (
    <div className="panel p-dom">
      <div className="panel-h">
        <span className="title">Depth of Market</span>
        <span className="sep" />
        <span className="meta">11 LVL · 0.25 TICK</span>
        <span className="spacer" />
        <div className="seg">
          <button className="active">Size</button>
          <button>Orders</button>
        </div>
      </div>
      <div className="dom-head mono">
        <div style={{ textAlign: 'center' }}>SΔ</div>
        <div style={{ textAlign: 'right' }}>EXEC</div>
        <div style={{ textAlign: 'right' }}>BID</div>
        <div style={{ textAlign: 'center' }}>PRICE</div>
        <div>ASK</div>
        <div>EXEC</div>
        <div style={{ textAlign: 'center' }}>SΔ</div>
      </div>
      <div className="dom-rows">
        {dom.map((r, i) => {
          const k = r.px.toFixed(2);
          const bidIntensity = r.bid ? r.bid / maxSize : 0;
          const askIntensity = r.ask ? r.ask / maxSize : 0;
          const exec = domExec ? (domExec[k] || { buy: 0, sell: 0 }) : { buy: 0, sell: 0 };
          const sess = domSessionDelta ? (domSessionDelta[k] || { buy: 0, sell: 0 }) : { buy: 0, sell: 0 };

          // Fade outer levels — dist from last-price row
          const dist = Math.abs(i - anchorIdx);
          const opacity = dist >= 4 ? 0.35 : dist >= 3 ? 0.6 : 1;

          // Bar widths
          const bidW = bidIntensity * 50;
          const askW = askIntensity * 50;

          return (
            <div key={i} className={'dom-row' + (r.last ? ' last' : '')} style={{ opacity }}>
              {r.bid ? <div className="bar bid" style={{ width: bidW + '%', opacity: 0.28 + bidIntensity * 0.57 }} /> : null}
              {r.ask ? <div className="bar ask" style={{ width: askW + '%', opacity: 0.28 + askIntensity * 0.57 }} /> : null}

              {/* Session-cumulative sell volume at this price (context: how hard sellers have hit here all day) */}
              <div className="col biddelta">
                {sess.sell > 0
                  ? <span className="dom-delta pull">{fmtK(sess.sell)}</span>
                  : null}
              </div>

              {/* Sell-side executions hitting the bid — per-bar */}
              <div className="col bidcum exec-sell">{exec.sell > 0 ? fmtK(exec.sell) : ''}</div>

              {/* Resting bid size, heat-colored */}
              <div className="col bidsize" style={r.bid ? { color: `color-mix(in oklab, var(--buy) ${Math.round(30 + bidIntensity * 70)}%, var(--fg-1))` } : undefined}>
                {r.bid || ''}
              </div>

              <div className="col price">{r.last ? <span className="last-arrow">▶</span> : null}{fmtPx(r.px)}</div>

              {/* Resting ask size, heat-colored */}
              <div className="col asksize" style={r.ask ? { color: `color-mix(in oklab, var(--sell) ${Math.round(30 + askIntensity * 70)}%, var(--fg-1))` } : undefined}>
                {r.ask || ''}
              </div>

              {/* Buy-side executions lifting the ask — per-bar */}
              <div className="col askcum exec-buy">{exec.buy > 0 ? fmtK(exec.buy) : ''}</div>

              {/* Session-cumulative buy volume at this price */}
              <div className="col askdelta">
                {sess.buy > 0
                  ? <span className="dom-delta add">{fmtK(sess.buy)}</span>
                  : null}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============== Time & Sales ==============
function TapePanel() {
  const { tape, sessionStats } = window.OF_DATA;
  const stats = window.OF_TAPE_STATS;
  const indData = window.OF_INDICATORS || {};
  const [filter, setFilter] = React.useState('lg');

  const tps = (stats.velocity[stats.velocity.length - 1] || 0);
  const hotThr = stats.avgVelocity > 0 ? stats.avgVelocity * 1.4 : Infinity;
  const buyPct = stats.aggressorPct;
  const sellPct = 1 - buyPct;
  const histMax = Math.max(...stats.histogram);

  // SpeedOfTapeInstant
  const sot = indData.speedOfTape || {};
  const intensity = sot.intensity || 0;
  const volRate = sot.volumeRate != null ? sot.volumeRate.toFixed(1) : '—';
  const intensityPct = Math.min(100, (intensity / 3) * 100);
  const intensityColor = intensity >= 2.5 ? 'var(--sell)' : intensity >= 1.5 ? '#e8c76a' : 'var(--buy-d)';

  // LG+ = top 15% of prints (tier lg or inst), Inst = top 3%
  const filteredTape = filter === 'all' ? tape
    : filter === 'lg' ? tape.filter(t => t.tier === 'lg' || t.tier === 'inst')
    : tape.filter(t => t.tier === 'inst');

  // Session cumulative delta
  const sessDelta = sessionStats.delta || 0;
  const deltaBarPct = Math.min(50, Math.abs(sessDelta) / Math.max(1, sessionStats.volume) * 100);

  return (
    <div className="panel p-tape">
      <div className="panel-h">
        <span className="title">Time &amp; Sales</span>
        <span className="sep" />
        <span className="meta">LAST {tape.length}</span>
        <span className="spacer" />
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'lg' ? 'active' : ''} onClick={() => setFilter('lg')}>Lg+</button>
          <button className={filter === 'inst' ? 'active' : ''} onClick={() => setFilter('inst')}>Inst</button>
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
          <span className="lbl">Intensity</span>
          <div className="tape-intensity-wrap">
            <div className="tape-intensity" style={{ width: intensityPct + '%', background: intensityColor }} />
          </div>
          <span className="val mono" style={{ color: intensityColor, minWidth: 44, textAlign: 'right' }}>{volRate}<span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>c/s</span></span>
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
          <span className="lbl">Cum Δ</span>
          <div className="cumdelta-bar">
            <div className={'fill ' + (sessDelta >= 0 ? 'pos' : 'neg')} style={{ width: deltaBarPct + '%' }} />
          </div>
          <span className={'val mono ' + (sessDelta >= 0 ? 'pos' : 'neg')}>{fmtSigned(sessDelta)}</span>
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
        {filteredTape.slice(0, 28).map((t, i) => {
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

// ============== Cumulative Delta ==============
function DeltaPanel() {
  const { delta, sessionStats } = window.OF_DATA;
  const [cvdMode, setCvdMode] = React.useState(false);
  const indData = window.OF_INDICATORS || {};
  const cvdState = indData.deltaCumulative || {};

  if (!delta.length) return <div className="panel p-delta" />;

  const W = 1000, H = 100;

  // ── CVD candlestick mode ──────────────────────────────────────────
  if (cvdMode && cvdState.candlestick && cvdState.candlestick.length > 0) {
    const bars = cvdState.live ? [...cvdState.candlestick, cvdState.live] : cvdState.candlestick;
    const allVals = bars.flatMap(b => [b.open, b.high, b.low, b.close]);
    const cvdMin = Math.min(...allVals);
    const cvdMax = Math.max(...allVals);
    const cvdRange = Math.max(cvdMax - cvdMin, 1);
    const yScale = (v) => H - 4 - ((v - cvdMin) / cvdRange) * (H - 8);
    const xStep = bars.length > 1 ? W / (bars.length - 1) : W;
    const lastCvd = cvdState.live?.close ?? cvdState.candlestick[cvdState.candlestick.length - 1]?.close ?? 0;

    const cvdLabelStyle = { position:'absolute', right:0, fontSize:'9px', lineHeight:'11px', color:'var(--fg-3)', fontFamily:"'JetBrains Mono',monospace", pointerEvents:'none' };
    const overlayBtnStyle = { position:'absolute', top:2, left:2, zIndex:1, all:'unset', cursor:'pointer', fontSize:'9px', fontFamily:"'JetBrains Mono',monospace", color:'var(--fg-2)', background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius:3, padding:'1px 5px', lineHeight:'14px', textTransform:'uppercase', letterSpacing:'0.06em' };
    return (
      <div className="panel p-delta">
        <div className="delta-wrap">
          <div style={{ flex:1, position:'relative', minHeight:0 }}>
            <button style={overlayBtnStyle} onClick={() => setCvdMode(false)} title="Switch to bar delta">CVD</button>
            <span style={{ ...cvdLabelStyle, top:0 }}>{Math.round(cvdMax)}</span>
            <span style={{ ...cvdLabelStyle, bottom:0 }}>{Math.round(cvdMin)}</span>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
              <line x1={0} x2={W} y1={yScale(0)} y2={yScale(0)} stroke="var(--line)" strokeDasharray="2 3" />
              {bars.map((b, i) => {
                const x = i * xStep;
                const yO = yScale(b.open), yC = yScale(b.close);
                const yHi = yScale(b.high), yLo = yScale(b.low);
                const up = b.close >= b.open;
                const col = up ? 'var(--buy)' : 'var(--sell)';
                const bW = Math.max(2, xStep * 0.7);
                const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yO - yC));
                return (
                  <g key={i}>
                    <line x1={x} x2={x} y1={yHi} y2={yLo} stroke={col} strokeWidth="1" />
                    <rect x={x - bW/2} y={bodyTop} width={bW} height={bodyH} fill={col} opacity="0.8" />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>
    );
  }

  // ── Default: per-bar delta histogram + cumulative line ────────────
  const xStep = delta.length > 1 ? W / (delta.length - 1) : W;
  const cumMax = Math.max(...delta.map((d) => d.cum));
  const cumMin = Math.min(...delta.map((d) => d.cum));
  // Scale to actual data extent so line fills the chart regardless of whether
  // CVD is net positive, net negative, or crosses zero.
  const span    = Math.max(cumMax - cumMin, 1);
  const dataLo  = cumMin - span * 0.06;
  const dataHi  = cumMax + span * 0.06;
  const LH = 60;
  const yScale  = (v) => LH - 1 - ((v - dataLo) / (dataHi - dataLo)) * (LH - 2);
  const zeroY   = Math.max(0, Math.min(LH, yScale(0)));
  const barMax  = Math.max(...delta.map((d) => Math.abs(d.delta))) || 1;
  const path    = delta.map((d, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${yScale(d.cum).toFixed(1)}`).join(' ');
  const labelStyle = { position:'absolute', right:0, fontSize:'9px', lineHeight:'11px', color:'var(--fg-3)', fontFamily:"'JetBrains Mono',monospace", pointerEvents:'none' };

  const overlayBtnStyle = { position:'absolute', top:2, left:2, zIndex:1, all:'unset', cursor:'pointer', fontSize:'9px', fontFamily:"'JetBrains Mono',monospace", color:'var(--fg-2)', background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius:3, padding:'1px 5px', lineHeight:'14px', textTransform:'uppercase', letterSpacing:'0.06em' };

  return (
    <div className="panel p-delta">
      <div className="delta-wrap">
        {/* Cumulative line — fills remaining space, scaled to actual data range */}
        <div style={{ flex:1, position:'relative', minHeight:0 }}>
          <button style={overlayBtnStyle} onClick={() => setCvdMode(true)} title="Switch to CVD candlestick">CVD</button>
          <span style={{ ...labelStyle, top:0 }}>{Math.round(cumMax)}</span>
          <span style={{ ...labelStyle, bottom:0 }}>{Math.round(cumMin)}</span>
          <svg viewBox={`0 0 ${W} ${LH}`} preserveAspectRatio="none" style={{ width:'100%', height:'100%' }}>
            <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--line)" strokeDasharray="2 3" />
            <path
              d={`${path} L ${W.toFixed(1)},${zeroY} L 0,${zeroY} Z`}
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
          </svg>
        </div>
        {/* Delta bar histogram — fixed height, bottom-anchored so full height is always used */}
        <div style={{ height:36, flexShrink:0 }}>
          <svg viewBox={`0 0 ${W} 36`} preserveAspectRatio="none" style={{ width:'100%', height:'100%' }}>
            {delta.map((d, i) => {
              const h = Math.max(2, (Math.abs(d.delta) / barMax) * 34);
              const x = i * xStep - xStep * 0.4;
              const w = xStep * 0.8;
              const fill = d.delta >= 0 ? 'var(--buy)' : 'var(--sell)';
              return <rect key={i} x={x} y={36 - h} width={w} height={h} fill={fill} opacity="0.8" />;
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

// ============== Large Trader Scanner ==============
function ScannerPanel() {
  const { largeTrades } = window.OF_DATA;
  const indData = window.OF_INDICATORS || {};
  const [tab, setTab] = React.useState('large');

  const blocks = (indData.deepTrades?.recentBlocks || []).slice().reverse().slice(0, 50);

  if (tab === 'blocks') {
    return (
      <div className="panel p-scanner">
        <div className="panel-h">
          <span className="title">Large Trader Scanner</span>
          <span className="sep" />
          <span className="spacer" />
          <div className="seg">
            <button onClick={() => setTab('large')}>Large</button>
            <button className="active">Blocks</button>
          </div>
          <span className="sep" />
          <span className="meta">{blocks.length} hits</span>
        </div>
        <div className="scan-head scan-row" style={{ gridTemplateColumns: '60px 1fr 50px 50px 60px' }}>
          <div>TIME</div>
          <div>PRICE</div>
          <div style={{ textAlign: 'right' }}>SIDE</div>
          <div style={{ textAlign: 'right' }}>SIZE</div>
          <div style={{ textAlign: 'right' }}>TYPE</div>
        </div>
        <div className="scan-rows" style={{ overflowY: 'auto' }}>
          {blocks.map((b, i) => {
            const tsMs = b.ts < 1e10 ? b.ts * 1000 : b.ts;
            const timeStr = new Date(tsMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            const isBuy = b.side === 'BUY';
            return (
              <div key={i} className="scan-row" style={{ gridTemplateColumns: '60px 1fr 50px 50px 60px' }}>
                <div className="time">{timeStr}</div>
                <div className="mono" style={{ color: 'var(--fg-1)' }}>{b.px.toFixed(2)}</div>
                <div className={'side ' + (isBuy ? 'buy' : 'sell')} style={{ textAlign: 'right', color: isBuy ? 'var(--buy)' : 'var(--sell)' }}>
                  {isBuy ? 'BUY' : 'SELL'}
                </div>
                <div className="size" style={{ textAlign: 'right' }}>{b.sz}</div>
                <div style={{ textAlign: 'right' }}>
                  {b.isAbsorption
                    ? <span className="tag" style={{ background: 'var(--sell-bg)', color: 'var(--sell)', fontSize: 9 }}>ABS</span>
                    : <span className="tag BLOCK" style={{ fontSize: 9 }}>BLK</span>
                  }
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="panel p-scanner">
      <div className="panel-h">
        <span className="title">Large Trader Scanner</span>
        <span className="sep" />
        <span className="meta">UNUSUAL SIZE · LAST 30M</span>
        <span className="spacer" />
        <div className="seg">
          <button className="active">Large</button>
          <button onClick={() => setTab('blocks')}>Blocks</button>
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

// ============== Indicator Signals Feed ==============
const SIG_LABELS = {
  SHIFT_BUY: '↑ SHIFT', SHIFT_SELL: '↓ SHIFT',
  BLOCK_PRINT: 'BLOCK', ABSORPTION: 'ABS',
  WALL_DETECTED: 'WALL', WALL_BROKEN: 'BRK',
  UNFINISHED_HIGH: 'UF ↑', UNFINISHED_LOW: 'UF ↓', AUCTION_RESOLVED: '✓ AUC',
  ZONE_TRIGGERED: 'IMB',
  ACCELERATION: 'ACCEL', PRESSURE: 'PRES', EXHAUSTION: 'EXHST', SLOWDOWN: 'SLOW',
  TAPE_SPIKE: 'SPIKE',
  BEARISH_DIVERGENCE: 'DIV ↓', BULLISH_DIVERGENCE: 'DIV ↑',
  BUY_STOP_RUN: 'STOP ↑', SELL_STOP_RUN: 'STOP ↓',
};
const BUY_TYPES  = new Set(['SHIFT_BUY', 'UNFINISHED_LOW', 'ACCELERATION', 'BULLISH_DIVERGENCE', 'BUY_STOP_RUN', 'ZONE_TRIGGERED']);
const SELL_TYPES = new Set(['SHIFT_SELL', 'UNFINISHED_HIGH', 'BEARISH_DIVERGENCE', 'SELL_STOP_RUN', 'WALL_DETECTED']);

function SignalsPanel() {
  const indData = window.OF_INDICATORS || {};
  const signals = (indData.allSignals || []).slice(0, 30);

  return (
    <div className="panel p-signals" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-h">
        <span className="title">Signals</span>
        <span className="sep" />
        <span className="meta">LAST 5M · ALL INDICATORS</span>
        <span className="spacer" />
        <span className="meta">{signals.length} recent</span>
      </div>
      <div className="sig-head">
        <div>TIME</div>
        <div>IND</div>
        <div>TYPE</div>
        <div style={{ textAlign: 'right' }}>PRICE</div>
      </div>
      <div className="sig-rows">
        {signals.length === 0
          ? <div className="sig-empty">No signals yet — waiting for bars to close</div>
          : signals.map((s, i) => {
              const tsMs = s.tsMs || (s.ts < 1e10 ? s.ts * 1000 : s.ts);
              const timeStr = new Date(tsMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
              const label   = SIG_LABELS[s.type] || s.type;
              const dir     = BUY_TYPES.has(s.type) ? 'buy' : SELL_TYPES.has(s.type) ? 'sell' : '';
              const tier    = (s.tier === 'A') ? 'a-tier' : 's-tier';
              const px      = s.data?.px ?? s.px ?? null;
              return (
                <div key={i} className={`sig-row ${dir} ${tier}`}>
                  <div className="time">{timeStr}</div>
                  <div className="ind">{s.ind}</div>
                  <div className="type">{label}</div>
                  <div className="px">{px != null ? px.toFixed(2) : '—'}</div>
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

// ============== Chart (Candle / Footprint) ==============
Object.assign(window, { Sidebar, DOMLadder, TapePanel, DeltaPanel, ScannerPanel, SignalsPanel });
