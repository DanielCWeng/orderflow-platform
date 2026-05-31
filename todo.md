Trades are happening inside the spread (The Cardinal Sin)

Look at your gen\_depth() logic:



If mkt.price is 5842.25

Your best bid is 5842.25 - 0.25 = 5842.00

Your best ask is 5842.25 + 0.25 = 5842.50

But your gen\_trade() executes trades at mkt.price (5842.25). Why this is bad: In a real market, a "Buy" trade means a market order hit the best Ask. A "Sell" means a market order hit the best Bid. Your mock is executing trades exactly between the Bid and Ask. If you feed this into a Footprint chart, it won't know whether to classify the trade volume at the bid or the ask, breaking your delta calculations.

Trades and the DOM are completely disconnected In your script, the DOM (gen\_depth) is regenerated from scratch every tick based on a math formula (math.exp). Meanwhile, your trades (gen\_trade) just generate random sizes. Why this is bad: Orderflow is the study of liquidity consumption. If your mock generates a 200-lot buy order, the Ask size on the DOM should instantly drop by 200. In your script, the trade happens, and the DOM doesn't react at all. Your DOM will look completely static and robotic, while your tape prints massive orders.

Price moves for no reason Your next\_price() function uses a sine wave and a random drift with a slight upward bias (random() - 0.492). It moves completely independently of trading activity. Why this is bad: Price only moves when all the liquidity at a level is consumed. If there are 100 contracts at the Ask, price cannot tick up until 100 buy contracts are executed. Because your price drifts magically, you will never see "sweeps" or "walls" being chewed through, which are the primary things orderflow traders look for.

Artificial Delta

You calculate global delta simply by adding or subtracting the size of the random trade. While technically mathematically correct for the mock, because the trades aren't interacting with the Bid/Ask correctly, any Cumulative Volume Delta (CVD) indicator you build on the frontend will look like a smooth, meaningless line rather than reacting to price extremes.



The "Hard Trend" (Directional Imbalance)

What it is: A relentless, grinding trend where aggressive buyers are completely overwhelming passive sellers. How to simulate it:



Buy/Sell Probability: Shift from 50/50 to 85% Buy / 15% Sell.

Asymmetric Liquidity: Bids replenish with massive size (supporting the move), while Asks replenish with very small size (getting chewed through easily). Why your UI needs this:

Stacked Imbalances: Orderflow traders look for "Stacked Imbalances" (e.g., 3 consecutive price levels where Buy Volume is 300% greater than Sell Volume). You need this regime to ensure your Footprint chart correctly highlights these imbalances in bold/colors.

CVD Scaling: Your Cumulative Volume Delta will go parabolic. You need to ensure your charting library dynamically scales the Y-axis properly.

"Absorption" / Iceberg Orders (High Volume / No Price Movement)

What it is: Price hits a major level (like yesterday's high), and massive aggressive market orders are absorbed by a giant passive limit order (Iceberg). Lots of volume transacts, but price refuses to move. How to simulate it:



Buy/Sell Probability: Heavy directional (e.g., 80% Buy).

Infinite DOM Replenishment: Hardcode a specific price level (e.g., 5850.00). No matter how many buy orders hit the Ask at 5850.00, do not let the liquidity drop to zero. Why your UI needs this:

Volume Profile POC: This will create a massive node on your Volume Profile. You need to verify that your "Point of Control" (POC) indicator correctly identifies and highlights this thickest level.

Delta Divergence: CVD goes straight up (lots of buying), but price stays flat. This is a classic orderflow setup. Your UI needs to display this clearly.

The "Lunchtime Chop" (Low Volatility / Mean Reverting)

What it is: Mid-day trading where algos are just ping-ponging the price back and forth in a tight 4-tick range. How to simulate it:



Trade Frequency: Very slow (1.5 to 3 seconds between trades).

High DOM Liquidity: Every level has 500+ contracts.

Mean Reversion: If price goes up 2 ticks, force the Buy/Sell Probability to heavily favor Sells to push it back down. Why your UI needs this:

Bar Building: If you are building Time-based bars (e.g., 5-minute), you need to make sure your chart handles bars that consist of almost no vertical movement but take a long time to close.

Volume Imprint: Ensures your Footprint doesn't look completely empty when activity dies down.

"Spoofing" / Liquidity Games (DOM-Specific Regime)

What it is: High-frequency firms flashing massive orders on the DOM 10 ticks away from the current price, then canceling them before price gets there to trick other traders. How to simulate it:



No Trades Required: Leave trades at a normal pace.

DOM Manipulation: Every few seconds, randomly pick a level 5-10 ticks away from the best price. Add 1,000 contracts to it. Wait 1.5 seconds. Remove them. Why your UI needs this:

DOM Heatmap/History: If you are building a modern DOM (like Bookmap, Jigsaw, or Sierra Chart), you need to track "Pulled" and "Added" liquidity. If a 1000-lot flashes and disappears without trading, your UI should visually indicate that liquidity was canceled, not consumed.





5\. Trade size distribution is empirically wrong

Your distribution generates block trades (80-300 lots) 1.5% of the time. In real ES, roughly 65-75% of all trades by count are 1-2 lots, and true block prints (50+ lots) are something like 0.1-0.3% of trade count. The issue isn't just aesthetics — it means your volume profile will have constant fat candles where real footprints would show a long, thin tape of small trades punctuated by the occasional large print. Your Footprint chart's imbalance highlighting will constantly fire when it should mostly be quiet. Flip the distribution: bias heavily toward 1-2 lots, make 3-10 lot trades the "medium" tier, and treat anything over 50 as genuinely rare.

6\. Aggressor classification has no structural basis

You're randomly assigning BUY or SELL at 49/51. But in a real matching engine, aggressor side is a mechanical output of the order type: a market buy hits the resting ask, a market sell hits the resting bid. There's no randomness in the assignment. This matters because your classification is the foundation of everything — delta, CVD, footprint cell colouring. If you're assigning it arbitrarily and also generating trades at mid-price (problem #1), your entire delta calculation is meaningless noise dressed up as signal. The fix for both #1 and #6 is the same: determine aggressor first, then set trade price accordingly. Buy aggressor → trade at best\_ask. Sell aggressor → trade at best\_bid. Price becomes that trade price. The mid is derived, not the execution level.

7\. No queue depletion = no real price discovery

The LOB clears trades by matching incoming market orders against best-available resting limit orders. Buy market orders cross the spread to execute at the best ask; sell market orders execute at the best bid. This means price cannot tick up until every contract at the current best ask is consumed. Your server has no concept of queue size at the best bid/ask as a consumable resource. next\_price() just drifts. The consequence for your UI is that you'll never see a true sweep — where a large order clears one level and immediately aggresses the next — because that mechanic requires the ask queue at level 1 to actually empty before price moves to ask level 2. This is the single most important thing to fix if you want your footprint chart to show anything resembling real orderflow. Emergent Mind

8\. DOM deltas are incoherent between updates

Every DOM refresh calls gen\_depth() fresh, rebuilding all 10 levels from the exponential formula. Between ticks, a 200-lot buy could print on the tape, but the next DOM snapshot might show more ask liquidity at that level than before. Your server is literally printing trades and then restocking the ask without any relationship. Empirical LOB investigations show it typically recovers from liquidity shocks within about 20 best-quote updates — meaning replenishment exists and is measurable, but it's finite and directional. The DOM should carry state between ticks, not be regenerated from scratch. Emergent Mind

9\. The sinusoidal drift is immediately obvious as synthetic

The 120-second sine period creates a visible, smooth oscillation that any orderflow trader will clock within 30 seconds. Real price processes exhibit volatility clustering — quiet periods followed by bursts — not smooth periodicity. Even if the frontend team doesn't consciously notice the sine wave, the CVD will look robotic because the drift is completely independent of the trade flow. A basic GARCH-like approach (where volatility of the next step is partially a function of recent squared returns) would be far more convincing and isn't much harder to implement.

10\. Trade arrival rate is uniformly wrong

TRADE\_HZ = 0.30 with 1-3 trades per batch gives you roughly 5-10 trades/second continuously. ES during normal trading runs 50-200 trades/second, with the open and close pushing higher. Midday is slower but still 10-30/second. More importantly, the distribution of inter-trade times matters as much as the rate — trade arrival is related to the state of the limit order book, clustering in bursts when a large order is working and going quiet when it's done. A simple Poisson-burst model (occasional high-frequency bursts of 20-30 trades in <500ms, separated by genuine quiet) would make your tape look dramatically more real. arXiv



On your regime architecture — developer feedback

The regime approach is the right call, but there are a few things worth thinking through before you write it:

State machine, not ad-hoc flags. Each regime should be a discrete state with its own parameter bundle: buy\_prob, ask\_replenish\_rate, bid\_replenish\_rate, trade\_freq\_ms, volatility\_scalar, spread\_ticks. A RegimeController class transitions between states on a timer. This prevents parameter bleed between regimes.

Timing for dev speed. You don't want a 7-hour day, but you also said you don't want flash crashes every 5 seconds. A reasonable compressed schedule:

RegimeDev durationOpen / gap60sHard trend90sAbsorption at a wall75sLunchtime chop120sFailed auction / reversal60sClose acceleration90s

That's \~8 minutes for a complete cycle, which is fast enough to iterate on but slow enough that your 30-second bars will have time to build meaningful footprints within each regime.

The absorption regime needs an explicit iceberg price. Don't approximate it — hardcode a level (e.g. ICEBERG\_LEVEL = 5850.00) and add a check in your queue depletion logic: if mkt.price == ICEBERG\_LEVEL and the direction is up, replenish the ask to a large fixed number on every tick regardless of what was consumed. The CVD should climb aggressively while price flatlines. This is the exact setup you want to stress-test your delta divergence indicator.

The spoofing regime needs a separate data structure. Add a flash\_orders dict to your market state: { price\_level: (size, expiry\_timestamp) }. Every DOM snapshot includes these, but they're tagged differently so your frontend can optionally distinguish them. Every few seconds the regime controller picks a level 5-10 ticks out, inserts a 500-1000 lot flash order, and removes it 1-2 seconds later with no corresponding trade print. If your frontend is building a DOM heatmap or a pulled-liquidity tracker, this is the test case that will break it if it's not handled.

One regime you haven't listed but should add: the failed auction. Price makes a directional 6-8 tick move with strong CVD, then volume suddenly dries up at the extreme — you get 2-3 bars of near-zero trade frequency — then aggressive orders flip direction and sweep back through. This creates a "delta exhaustion" signal that's a primary entry trigger for professional orderflow traders. Your UI needs to handle the abrupt volume collapse and subsequent reversal cleanly.



Priority order for fixing the base server before adding regimes:



Fix aggressor determination → trade price (BUY @ ask, SELL @ bid) — everything else cascades from this.

Add queue state to the DOM — consumable resting size at best bid/ask, not regenerated from scratch.

Tie price movement to queue depletion — price ticks only when the queue at best bid/ask hits zero.

Fix size distribution — weight 1-2 lots heavily.

Replace sine drift with a volatility-clustering random walk.



ixes all the base microstructure issues:



Aggressor classification → trade price (BUY @ ask, SELL @ bid)

Queue state in DOM (consumable resting size at best bid/ask)

Price movement tied to queue depletion

Correct size distribution (heavily weighted to 1-2 lots)

Volatility-clustering random walk (replace sine drift)





Regime state machine with:



Open/gap (60s)

Hard trend (90s)

Absorption at a wall (75s)

Lunchtime chop (120s)

Failed auction/reversal (60s)

Close acceleration (90s)





News release event:



All liquidity pulled

Big price move

Trends sideways for a bit







Let me think through the architecture carefully before writing.

Core Architecture

Market State:

pythonclass Market:

&#x20;   price: float  # last trade price

&#x20;   best\_bid: float  # current best bid

&#x20;   best\_ask: float  # current best ask

&#x20;   ask\_queue: float  # resting size at best ask

&#x20;   bid\_queue: float  # resting size at best bid

&#x20;   open\_: float

&#x20;   high: float

&#x20;   low: float

&#x20;   volume: int

&#x20;   delta: int

&#x20;   t0: float

&#x20;   

&#x20;   # Volatility clustering

&#x20;   recent\_returns: deque  # for GARCH-like vol estimation

&#x20;   current\_vol: float

Aggressor Classification \& Trade Price:



Determine aggressor direction first (based on regime buy\_prob)

BUY aggressor → trade at best\_ask

SELL aggressor → trade at best\_bid

After trade, consume from queue

When queue depletes → price ticks, new queue replenishes



Queue Depletion \& Price Movement:



ask\_queue tracks remaining size at current best ask

When a buy trade hits: consume from ask\_queue

If ask\_queue <= 0: price ticks up by TICK, new ask\_queue replenishes (based on regime)

Same for bid\_queue on sell trades



DOM State:



Maintain actual LOB state as a dict of {price: size}

Update incrementally rather than regenerating

Best bid/ask derived from LOB state



Regime Controller:

