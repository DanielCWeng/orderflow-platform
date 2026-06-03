Here is an in-depth code review of mock\_server.py v3, categorizing bugs from

Critical (Game-Breaking) to Minor (Logic/Edge cases).



🚨 1. Critical Architecture Bugs (Application Breakage)



A. Multi-Client Concurrency Mutates Global State



The most severe bug lies in the relationship between the handle\_ws function and

the global mkt object.



&#x20; - The Bug: handle\_ws contains a while not ws.closed: loop that actively

&#x20;   generates trades via t = gen\_trade(regime). The gen\_trade function mutates

&#x20;   the global mkt object (mkt.price, mkt.lob, mkt.vol, etc.).

&#x20; - The Impact: If two clients connect to the WebSocket, both loops will run

&#x20;   simultaneously. The market will suddenly generate trades at 2x speed. Worse,

&#x20;   Client A will generate a trade and mutate the global price, but only send

&#x20;   that trade to Client A. Client B will do the same. Their charts will

&#x20;   completely diverge, and the global LOB state will become wildly corrupted

&#x20;   due to interleaved mutations.

&#x20; - The Fix: Decouple the market simulation from the client connection. Create a

&#x20;   single async def market\_simulator\_loop() that runs in the background to

&#x20;   update the global mkt state and pushes updates to a centralized message

&#x20;   queue or list of connected WebSocket clients.



B. Massive Price Gap Between History and Live Data



&#x20; - The Bug: In generate\_history(), you create a local instance of the market (h

&#x20;   = Market()) to simulate the last 240 bars. This moves h.price organically.

&#x20;   However, when the WS connects, the live stream uses the global mkt object,

&#x20;   which is still sitting statically at INIT\_PX (5842.25).

&#x20; - The Impact: If the historical simulation ended at 5800.00, the moment the

&#x20;   live WebSocket connects, the live chart will gap instantly back to 5842.25,

&#x20;   completely ruining the chart view.

&#x20; - The Fix: At the end of generate\_history(), you must sync the global state

&#x20;   with the final historical state:

&#x20;   mkt.price = h.price

&#x20;   mkt.vol = h.vol

&#x20;   mkt.lob = h.lob

&#x20;   mkt.ou\_bias = h.ou\_bias



⚠️ 2. Major Logical Bugs (Market Mechanics)



A. L1 Consumption Overwrites L2 (Flickering DOM)



&#x20; - The Bug: In LOB.consume\_ask and LOB.consume\_bid, when a level is cleared,

&#x20;   the code artificially generates a new level:

&#x20;   new\_px = snap(px + TICK)

&#x20;   # ...

&#x20;   self.asks\[new\_px] = max(1, replenish + random.randint(-jitter, jitter))

&#x20; - The Impact: new\_px almost certainly already exists in the order book (as

&#x20;   L2). By using =, you are completely overwriting the existing resting

&#x20;   liquidity at L2 with a newly randomized number. This causes the sizes in the

&#x20;   DOM to flicker erratically every time L1 is consumed.

&#x20; - The Fix: Add to the existing level instead of overwriting:

&#x20;   current\_sz = self.asks.get(new\_px, 0)

&#x20;   self.asks\[new\_px] = max(1, current\_sz + replenish + random.randint(-jitter, jitter))



B. The Uncross "Double Vacuum" Bug



&#x20; - The Bug: In LOB.\_uncross(), you capture ba = self.best\_ask() and bb =

&#x20;   self.best\_bid(). If bb >= ba, you delete the offending bids. Then, using the

&#x20;   original bb, you delete the offending asks.

&#x20;   to\_del = \[p for p in self.bids if p >= ba] # Bids deleted

&#x20;   to\_del = \[p for p in self.asks if p <= bb] # Asks deleted using OLD bb!

&#x20; - The Impact: Because you use the cached bb instead of recalculating it, you

&#x20;   delete liquidity on both sides of the book simultaneously. This creates a

&#x20;   sudden, unnatural "vacuum" or empty gap in the order book whenever a

&#x20;   volatile move causes a cross.

&#x20; - The Fix: Only adjust one side, or recalculate bb after the bid deletion

&#x20;   before processing asks.



C. Asymmetric Spread Tightener (Permanent Upward Drift)



&#x20; - The Bug: In LOB.replenish(), if the spread blows out (gap\_ticks > 2), the

&#x20;   code forcefully injects liquidity to tighten it:

&#x20;   fill\_px = snap(ba - TICK)

&#x20;   self.bids\[fill\_px] = max(...) 

&#x20; - The Impact: It only ever steps the bid up to chase the ask. It never steps

&#x20;   the ask down. Over a long session, every time volatility widens the spread,

&#x20;   the bid acts as a ratchet, creating an artificial, permanent upward drift

&#x20;   bias on the asset price.

&#x20; - The Fix: Randomize which side steps in to tighten the spread:

&#x20;   if random.random() > 0.5:

&#x20;       self.bids\[snap(ba - TICK)] = ...

&#x20;   else:

&#x20;       self.asks\[snap(bb + TICK)] = ...



🔍 3. Minor Bugs \& Edge Cases



A. Spoofing is Invisible at Empty Levels



&#x20; - The Bug: In gen\_depth, the enrich function attaches flash (spoof) orders to

&#x20;   the DOM. However, it only iterates over levels (which are the resting

&#x20;   bids/asks returned by snapshot()).

&#x20; - The Impact: If the spoofing algorithm (maybe\_spoof) picks a price 8 ticks

&#x20;   away where there happens to be 0 resting size, the spoof order will simply

&#x20;   not render on the frontend because that price level isn't in the base

&#x20;   snapshot().

&#x20; - The Fix: Inject the flash\_px into the snapshot arrays before enriching if it

&#x20;   doesn't already exist.



B. Identical Timestamps on Burst Trades



&#x20; - The Bug: In handle\_ws, you loop for \_ in range(n\_trades): and generate up

&#x20;   to 20 burst trades instantly. All of them call int(time.time() \* 1000).

&#x20; - The Impact: They will all have the exact same millisecond timestamp. Many JS

&#x20;   frontend charting libraries (like Lightweight Charts or TradingView) will

&#x20;   scramble the order of trades if the timestamps are perfectly identical,

&#x20;   making the tick-chart draw squiggly/backwards lines.

&#x20; - The Fix: Artificially stagger the timestamps in the burst loop: t\['st'] =

&#x20;   int(time.time() \* 1000) + \_



C. Incorrect GARCH Lag implementation



&#x20; - The Bug: In the GARCH vol update (update\_vol), you calculate the squared

&#x20;   error using e2 = mkt.recent\_returns\[-2].

&#x20; - The Impact: Array index -1 is the most recent return. By using -2, your

&#x20;   volatility calculation is lagged by one full tick unnecessarily. Standard

&#x20;   GARCH(1,1) implementation relies on r\_{t-1}^2.

&#x20; - The Fix: Change to e2 = mkt.recent\_returns\[-1].



D. Total Volume Doesn't Reset



&#x20; - The Bug: mkt.volume increments endlessly. In gen\_quote, you pass this as tv

&#x20;   (Total Volume).

&#x20; - The Impact: Order flow APIs usually represent Total Volume as daily volume.

&#x20;   Because you pre-generate 2 hours of history (which increments h.volume), if

&#x20;   you fix the history bug (1B), the live session will start with 2 hours of

&#x20;   accumulated volume, which is fine. But it will never reset if left running

&#x20;   overnight. (Acceptable for a mock, but worth noting).



E. Iceberg Offset Drifts into Irrelevance



&#x20; - The Bug: mkt.iceberg\_px is set once at the beginning of the absorption

&#x20;   regime: mkt.iceberg\_px = snap(mkt.price + 8 \* TICK).

&#x20; - The Impact: If the price trends downward by 20 ticks early in the 75-second

&#x20;   regime, the iceberg is left stranded 28 ticks above the action and will

&#x20;   never be interacted with.

&#x20; - The Fix: To make absorption realistic, the iceberg should trail the price,

&#x20;   or be placed closer (e.g., + 2 \* TICK), or recalculate dynamically if price

&#x20;   drifts too far away.



