On the DOM:

BID / PRICE / ASK — always live snapshot, never accumulates. This is the resting book — it's continuously overwritten as orders appear, pull, or get hit. There's no useful "memory" here because stale resting size is meaningless. These are your ground truth anchor: what's there right now.

EXEC (both sides) — resets per bar, builds within the bar. This is the footprint logic. Within a candle, every execution that hits bid or lifts ask at each price increments that cell. You're building a live picture of "how much has traded at this level in this bar." When the bar closes, it resets. If it compounds session-wide, it becomes a volume profile — which is useful, but it's a different tool that answers a different question and will eventually dwarf any within-bar signal. For scalping reads (absorption, exhaustion, imbalance) you need per-bar resolution. Keep EXEC on bar time.

Δ — this is where your design decision lives, and it's the one worth thinking about carefully.

If both Δ columns are also per-bar, you have a problem: per-bar Δ is just EXEC ask minus EXEC bid at each level. Mathematically redundant. You'd be showing the same thing three ways (bid EXEC, ask EXEC, and the difference between them). That's visual noise burning column space.

The layout only justifies having Δ as a distinct column if it's on a different time horizon than EXEC. The answer that makes it non-redundant: make Δ session-cumulative. It builds from the open and never resets intraday. Now the layout is actually answering two different questions simultaneously:



EXEC = what is this bar doing right now — the trigger read

Δ outer = where has net pressure built up all session — the context read



In your screenshot that has 72% buy aggression hammering into 1313 resting offers at 6753 — the EXEC columns tell you how aggressive buyers are being right now in this bar, while a session-cumulative Δ tells you whether that level has been a net buyer or seller magnet all day. Those are genuinely different signals.





On the T\&S

This is your strongest panel and I'd change the least. The velocity (23/s) and live aggressor ratio (72/28) are genuinely good — most tapes don't synthesise the raw prints into a signal at all, and at 23 prints/second the raw scrolling list is essentially unreadable. Be honest with yourself about that: staring at a tape flying past at 23/s isn't processing information, it's hypnosis. The value lives in (a) the aggregate bars and (b) the LG+ filtered view. So:

Make LG+ your default, ALL secondary. At this speed the unfiltered list is noise. You want size — institutional prints — not 1-lots. Set a deliberate large threshold (e.g. ES prints ≥25–50 lots depending on session) and let the small stuff disappear.

Push aggressor colour to binary, high-contrast. Lifted-offer green vs hit-bid red, unambiguous, with large prints scaled up in font or background intensity so a 50-lot screams and a 1-lot whispers. Your current highlighting is a bit muted; for a fast tape the colour has to do the reading for you. (Confirm what your ×3/×4/×7 tags mean — if they mark consecutive prints stacking at a price, keep them; if they're just decorative, they're costing you attention.)

The one addition worth it: cumulative delta, not just the aggressor %. Your 72/28 is a snapshot ratio. Cumulative delta since a reference (session open, IB, a swing) tells you net pressure over time and whether price is confirming or diverging from it — delta rising while price stalls into that offer wall is the absorption tell again. The snapshot can't show you the trend.

