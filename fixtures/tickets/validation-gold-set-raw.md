---
### Ticket 1 — OFBiz OFBIZ-13462
**Link:** https://issues.apache.org/jira/browse/OFBIZ-13462
**Summary:** MRP Run - Constrained (Finite Capacity) Mode
**Description:**
OFBiz MRP engine currently plans with an infinite-capacity assumption. When it back-schedules a proposed production run from its required-by date, it only checks the machine's working calendar — which weekdays the machine is open and for how many hours. It never checks how much of that time is already taken, either by existing production runs on the shop floor or by other orders proposed within the same MRP run.

As a result, every proposed order sees every machine as completely free. Two runs each needing 6 hours on a machine with an 8-hour day are both planned onto the same day — 12 hours of work into an 8-hour window — with no warning. The plan looks feasible on paper but is impossible to execute, and planners must find and resolve these overloads manually.

MRP should offer an optional mode to trigger a *_Constrained Capacity_* run with finite-capacity planning i.e., treat each machine's daily capacity the way MRP already treats material — as a limited resource that each planned order consumes — so that later orders only get what remains, demand is prioritized by date (the same principle used for material netting), and orders that cannot fit are visibly delayed or reduced (flagged Late/Short on the Requirement) rather than silently overbooked.

Not to mention, the *default ({_}Unconstrained Capacity{_})* run would remain untouched, so existing users see zero change unless they opt in for Constrained run or make it default (check "Configuring Default MRP Mode" section below).

The ‘{*}Constrained Capacity{*}’ mode is *Optional* and disabled by default, MRP defaults to ‘Unconstrained Capacity Plan’ mode which behaves exactly as today.
h2. *High Level Feature Expectation*

{*}_Terminology_{*}{_}:{_}
 * _a "proposed production run" is a planned manufacturing order that the MRP run creates;_
 * _a "committed production run" is an existing approved or running production run on the shop floor; the "originating demand" is what triggered a proposal — typically a customer sales order, or a stock level falling below its configured minimum._

How the MRP run works when the new *Constrained Capacity* mode is switched on:
 * Capacity committed to open and running production runs is accounted for by schedule priority: a committed run whose estimated start date is earlier than (or equal to) a proposed run's start date holds its booked capacity first; a proposed run whose start date is earlier than a committed run's estimated start date claims the capacity its dates require, even if its work overruns into the committed run's window — such overlaps are permitted, reported as capacity conflicts, and left to the planner to resolve manually.
 * Competing demand among proposed orders for the same machine is served in requirement-date priority — the same principle used for materials.
 * Orders are scheduled backward from their due date; if capacity forces the start into the past, the order is scheduled forward instead and marked {*}Late{*}.
 * If an order cannot be completed even within the allowed delay window, its quantity is reduced to what capacity allows and it is marked *Short* (down to zero, with the unmet demand reported).
 * The knock-on effects are handled automatically. A reduced supply triggers re-sizing of the following orders for the same product, so nothing falls through the cracks. In multilevel bills of material, a delayed component automatically pushes its parent's schedule out — the final plan never shows an assembly starting before its parts are ready. The flags travel with the requirements and onto the production runs created from them.
 * {*}Late/Short indicators{*}, the original required date, and any unmet quantity are stored on the resulting requirements, carried through to production runs on conversion, and every affected order names the bottleneck machine so planners know where to act.
 * Later, post-MRP run, produce a _Capacity Conflict report_ listing every permitted overlap between proposed and committed work, for planner resolution.

*Scenario Planning: Two plans side by side - Constrained and Unconstrained modes*

Each MRP run can be executed in one of two modes — Constrained Capacity (finite capacity run, this feature) or Unconstrained Capacity (infinite capacity run- today's behaviour) — and everything a run produces is stamped with its mode. A new run replaces only its own mode's results: its MRP events and its unapproved requirements. The other mode's plan survives untouched. This lets planners keep both pictures at once — what demand truly wants (unconstrained) next to what capacity can deliver (constrained) — and read the gap between them as the measurable cost of the capacity constraint.

*Configuring Default MRP Mode*

Each facility designates one mode as its {*}_Default MRP Mode_{*}. Requirements from that mode are normal proposals and can be approved as today. Requirements from the other mode are created in a *_Simulated_* status that cannot be approved — the approve action doesn't apply/exist for them, so nobody can accidentally act on the reference plan and double-order. Anything already approved is a commitment: it is never deleted, never demoted, and is counted as real supply by both modes.

*_Upgrade_* — deliberately switching which mode is Default MRP Mode. If the simulation proves to be the better plan, a planner with the right permission *_Upgrades_* it: one explicit, logged action that swaps the two plans' statuses.
 * The simulation's proposals become the approvable set;
 * The old plan's unapproved proposals are demoted to Simulated (kept for comparison — and making the upgrade reversible); The requirement status changes are logged.
 * Approved commitments are untouched.
 * A single simulated requirement can also be upgraded individually when only one piece of the simulation is wanted.
 * Recommended practice: Upgrade, and then immediately re-run MRP in the newly active mode, so the live plan is regenerated fresh against everything that changed since the simulation was computed.

h2. Important Rules

*R1 — Two modes, and the existing one is untouched.* A run is either *Constrained* (capacity is finite) or *Unconstrained* (today's behaviour). Each stamps its own results and replaces only its own, so a planner can hold both and compare what the factory _wants_ against what it {_}can do{_}. With the feature unused, results are identical to the current release.

*R2 — Orders are planned one at a time, in priority order.* Each demand is planned through its whole product tree before the next is considered, all of them drawing on the same pool of stock and machine hours. Whoever is planned first takes what it needs; later demands see what is left. This is what allows every requirement to be traced back to the order it serves.

*R2a — Every demand keeps its own requirement, even for the same product.* Two orders for one product are planned one after the other and recorded as two requirements, never merged into a single larger one. Each carries the quantity, dates and shortfall of the demand it serves, so a planner can always answer which order a proposed batch belongs to. Merging would lose that link, and there would be no way to tell which customer a shortage falls on.

{*}R3 — Priority classes decide who is served first{*}, ahead of dates. Dates order demands _within_ a class.
 # Approved sales orders
 # Parts for production runs already on the floor
 # Parts for approved shop orders
 # Topping stock back up to its minimum
 # Sales forecast

*R4 — Anything already on hand or already coming is counted first.* Stock, approved purchase orders, open production runs and approved requirements all reduce what the plan proposes. Supply that arrives _later_ than wanted still counts — the work waits for it and is flagged, rather than the same material being ordered twice.

*R4a — An open production run delivers what it still owes, whatever state its operations are in.* A run's remaining output counts as supply because output is still owed on it, not because machine time is still booked for it. A run whose last machine step is finished — with only a machine-less step such as a trim or an inspection left — is _closer_ to delivering, so its balance is credited and dated from the run's own finish. The one case that credits nothing is a run whose remaining work cannot be placed inside the planning window at all, because its components cannot arrive in time.

*R5 — A level covered by supply pulls no components.* If the skateboards are already coming, the plan does not order deck materials for them.

*R6 — A shortage is flagged, not hidden.* A requirement always shows the *full* quantity needed. Where capacity or material falls short, it records how much cannot be covered rather than quietly asking for less. What can actually be made is {_}quantity minus unmet quantity{_}.

*R7 — A part that arrives in time causes a delay; one that cannot causes a shortage.* Where a purchase can land inside the planning window, it is ordered and production simply waits — the quantity is unaffected. Only a part that cannot be here in time, because it has no supplier or because its lead time runs past the window, limits how much can be built. Lead time is counted in the supplier's *working* days.

{*}R8 — The required-by date is when the whole order is finished{*}, walked through the working calendar, even if that falls past the horizon. The receipt shows its own, earlier date: when the units that genuinely land are ready.

*R8a — The ideal date assumes material and capacity were fully available, and may fall in the past.* Beside every date the plan can actually achieve, a requirement carries the date it _should_ have had: what the demand would have required if nothing had been short and the machine had been free, measured against each resource's own calendar. It deliberately runs back past today when the demand is already overdue — that is what shows a purchase as late instead of quietly re-baselining it to today. What separates this from the achievable date is {*}load{*}, never the calendar: an ideal date honours working days, holidays and shutdowns exactly as the achievable one does, because a closed day is a fact about the plant and not a queue of other orders.

*R9 — No date is ever set in the past.* A run started at 4 pm does not plan work into that morning. Work that should already have started begins *now* and is flagged late.

*R10 — Work already on the floor is placed first and never moved.* Only what genuinely remains is booked — the outstanding quantity, skipping finished operations, and charging setup only where the floor has recorded it was done.

*R11 — A machine waiting for parts is held idle rather than given away.* Lower-priority work may use that idle time only if it finishes *entirely* before the waiting order starts. A job is never split in two around it, because that would mean setting the machine up twice while the plan paid for one setup.
This prohibition is on splitting a job *in time on one machine* — a job is never broken around other work sitting in the middle of its day. Dividing a job between the *machines* of a group is a different thing, governed by R12, and each piece of a divided job is itself an unbroken block on its own machine.

*R12 — A job runs on one machine of a group, and jobs spread across the group.* Two 8-hour machines offer 16 hours of work in a day, but one job uses one machine and runs at that machine's pace. Where several jobs need the group they are placed on different machines and run {*}at the same time{*}, the emptier machine chosen first. A job too large for any single machine to deliver on time is divided between machines, and {*}each piece pays its own setup{*}. A step may instead name one machine, in which case only that machine is considered.

A job that already meets its date is never divided, even when other machines stand idle: dividing exists to make a date achievable, not to finish early — the same reasoning as R15.

*R13 — A shared calendar is not a shared machine.* Two machines on the same calendar each get their own full hours.

*R14 — Time comes from the estimates; capacity is used only where a machine is named.* A step with a time but no machine still takes that long and consumes no capacity.

*R15 — Capacity is balanced by day, and work is placed to finish when it is due.* ** No machine is booked beyond its hours for a day, and every job carries a start and finish time. A job that can be delivered on time is placed to finish at its due moment, not as early as the machine allows — an order due at 16:00 runs up to 16:00 rather than finishing mid-morning and sitting as stock. Jobs queue behind one another on the same machine, time held in front of an order waiting for parts is not given away, and a smaller job may take that gap only if it finishes before the waiting order begins. An order that cannot be delivered on time is placed as early as it can be instead, since finishing late is the only remaining choice. What the plan does not do is _optimise_ the resulting order — it follows planning priority, not the fewest machine changeovers.

*R16 — Approving a requirement makes it a commitment.* Re-running the plan never deletes or downgrades an approved requirement, and both modes count it as supply.
h1. How Constrained Capacity Mode Would Work 
 # *Committed work is placed first.* Open production runs are laid into capacity before any proposal is sized — whatever their dates. A committed run scheduled later is not displaced by an earlier-needed proposal, and MRP never reschedules or modifies one.

 # *Demands are served in priority CLASSES, then by date.* Sales orders, then the components of open production runs, then the components of approved internal requirements, then below-minimum stock, then forecast. Dates order demands within a class, not across classes.

 # *Backward scheduling with a forward fallback.* Orders schedule backward from their due date; where capacity would force a start into the past, they are scheduled forward instead and flagged {*}Late{*}.

 # *A shortage is flagged, not shrunk.* Where capacity or material cannot cover the full quantity, the requirement keeps its *net requirement* and records {{unmetQuantity}} with {*}Short{*}. What can actually be made is {{{}quantity − unmetQuantity{}}}. The quantity is never quietly reduced.

 # *Cascades run down the tree, not across orders.* A delayed component pushes its parent's start; a short component caps what the parent can build. There is no backlog carried onto a later order for the same product — the shortfall already sits on the requirement that could not cover it.

 # *Flags and tracking.* Late and Short indicators, the date the plan was measured against, and unmet quantities persist on requirements and events. This would _*Not yet carry*_ that context onto a production run or Purchase Order at conversion.

h2. *Entity Model extensions*

The feature adds following new fields to the *Requirement & MrpEvent* entity:
 * *_Requirement.isLate_* (Lateness Indicator): Tells that this requirement could not be met by its need date and was pushed out due to machine capacity (reuse existing MrpEvent.isLate but add new one on Requirement)
 * *_Requirement.isShort_* (Shortness indicator): Tells that this requirement's quantity was reduced because capacity couldn't cover the full demand
 * {*}_Requirement.idealRequiredByDate_{*}: The date the demand actually needed, kept unchanged even after the plan pushed the requirement later — so the delay is always measurable (planned date vs. original date)
 * {*}_Requirement.unmetQuantity_{*}: How many units of the original demand remain uncovered after the reduction
 * {*}_Requirement.mrpModeEnumId_{*}: Which mode's run produced this requirement – Constrained or Unconstrained.
 * {*}_MrpEvent.mrpModeEnumId_{*}: Which mode's run produced this event; a new run deletes and regenerates only events of its own mode
 * {*}_Facility_{*}.{*}_defaultMrpModeEnumId_{*}:  which mode is "default" per facility during MRP run. The _Promote_ action is the only thing that revises it.

*Supporting reference data (seed data, not schema)*
 * Two enumeration values for the MRP Mode: _MRP_CONSTRAINED, MRP_UNCONSTRAINED_ (with their enumeration type).
 * One new requirement status: _REQ_SIMULATED_ — the status given to requirements created by the non-Default MRP Mode. The status transition table deliberately contains no path from Simulated to Approved; the only exits are deletion by that mode's next MRP run, or the {_}Promotion{_}. This is what makes accidental approval of the reference plan structurally impossible rather than merely warned against.
 * _*New* *MRP event types*_ {{INTERNAL_REQ_RECP}} and {{{}INTERNAL_REQ_REQ{}}}. No new tables: capacity bookkeeping is in working memory for the run.

*Points that matter functionally:*
 * All the capacity bookkeeping during a run happens in working memory and leaves no new tables behind; what persists are the requirements themselves (now carrying these flags), the normal MRP events, and the conflict report entries.

 * Existing data is untouched. Requirements created before this feature simply have the new fields empty; no migration or cleanup is needed, and running with the feature off never populates them.

 * Approved requirements are outside all of this. Approval fixes a requirement as a commitment: it is never deleted by any run of either mode, never demoted by {_}Promote{_}, and is counted as real supply by both modes.

The flags are durable and follow the work. They stay on the requirement after the MRP screen is closed, can be listed and filtered on requirement screens (e.g., "show all Short requirements for this facility"), and their context is carried onto the production run when a requirement is approved and converted — so the shop floor sees that a run was planned late or reduced, and why.
h1. Use Cases

Every case is written against the *manufacturing-demo dataset (OFBIZ-13438)* so it can be set up and checked by anyone, and every case is verifiable from the data the run produces — no case depends on reading a log.
h3. The demo scenario in plain terms

A skateboard factory, facility {*}MFG_PLANT{*}, with two machines:
||Machine||Works||Hours||
|*LAM*|Monday, Wednesday, Friday|08:30–16:30|
|*AMC*|Monday to Friday|08:30–16:30|

Two things are made:
 * {*}DSK15144-00{*}, the skateboard {*}deck{*}, made on LAM from veneers and glue.
 * {*}DCGAPSOSR12{*}, the finished {*}skateboard{*}, made on AMC from one deck plus a sticker, a warranty card and a transfer.

Every manufacturing step costs the same in this dataset: *15 minutes to set the machine up, then 5 minutes per unit.* So a full 8-hour day is 480 minutes, less 15 for setup, leaving 465 — {*}93 units a day{*}, on either machine. That single figure explains most of the numbers below.

Bills of material: one skateboard needs 1 deck, 1 sticker, 1 warranty card, 1 transfer. One deck needs 2 face veneers, 2 cross-ply veneers, 3 core veneers and 0.83 of a unit of glue.

Every purchased part has a supplier, a lead time and a minimum order quantity. What separates them is {*}how long they take{*}: a part that can arrive inside the planning window merely delays production, while one whose lead time runs past the window limits how much can be built at all. That distinction drives several cases below.

Minimum stock levels are 100 finished skateboards and 50 decks. The demo seeds no stock or orders, so the cases below assume a small set of transactional data — sales orders, production runs, purchase orders and opening stock — defined once in "The scenario these cases run against" and referenced by name.
h3. Key Terms 
 * *Demand* — something that needs making or buying: a sales order, a min stock, or parts for an order already on the shop floor.
 * *Requirement* — what the plan proposes in response: make this many, by this date.
 * *Committed work* — production runs already released to the floor. The plan works around them.
 * *Late* — the plan cannot deliver by the date asked for. *Short* — it cannot deliver the full quantity.
 * *Horizon/Planning Horizon* (or fence) — how far ahead the run plans. Beyond it, the run says nothing.

h2. A. Competing for machine time

*CASE-1 — Two orders want the same machine on the same day.* 
*_Setup:_* *SO-A* (60 units) and *SO-B* (50 units), both wanted the same Friday. AMC makes 93 a day. 
*_Expected:_* the earlier-dated order is served first and takes what it needs; the second is planned into the hours that remain and spills onto the previous working day. Neither day is booked beyond 8 hours. 
*_Why:_* today both would be planned onto the same day, 110 units into a 93-unit day, with nothing to warn the planner.

*CASE-2 — Work already on the floor keeps its machine time.* 
*_Setup:_* *PR-OPEN* (50 decks, approved, starting Monday), then a sales order needing deck time. 
*_Expected:_* the released run keeps Monday; the new demand is planned around it. The plan never moves or rewrites work already on the floor.

*CASE-3 — An overdue run still occupies the machine.* 
*_Setup:_* *PR-OVERDUE* — as PR-OPEN, but its planned start is a week in the past and it never started. 
*_Expected:_* its remaining hours are treated as occupying the machine from today forward, not from a date in the past. If the run happens after the shift has closed, that work lands on the next working day. 
*_Why:_* the work still has to happen; pretending it happened last week would hand its hours to something else.

*CASE-4 — Only the work genuinely left is booked.* 
*_Setup:_* *PR-RUNNING* — 100 decks, 40 already produced, the LAM step finished and its setup recorded. 
*_Expected:_* only 60 units of remaining work are booked, the completed step is not booked again, and setup is not charged a second time. 
*_Why:_* re-booking finished work takes hours back off the shop floor and pushes everything behind it later.

*CASE-5 — Parts already issued to a run are not demanded again.* 
*_Setup:_* *PR-ISSUED* — a run needing 300 core veneers, 150 of them already issued to it. 
*_Expected:_* demand is raised for the outstanding *50* only. A part fully issued raises none. 
*_Why:_* the plan only reorders what has not yet physically left the store.

*CASE-6 — Setup is charged until the floor says it was done.* 
*_Setup:_* *PR-BARE* — marked running, but nothing produced, nothing issued, no actual setup recorded. 
*_Expected:_* its 15 minutes of setup are still charged. 
*_Why:_* marking a job as started is an intention; recorded setup time is a fact. Releasing the setup on a status alone hands the plan 15 minutes that the machine has not actually saved.

*CASE-7 — Late rather than short.* 
*_Setup:_* *SO-LATE* — 200 skateboards wanted the first Wednesday, roughly 17 hours of AMC time. 
*_Expected:_* the plan schedules it forward across the following working days, marks it {*}Late{*}, and keeps the original Wednesday date so the delay can be measured. 
*_Why:_* a planner needs to know both what was promised and what is achievable.

*CASE-8 — Short when the horizon genuinely cannot fit it.* 
*_Setup:_ SO-BIG* — 600 skateboards, run with a 5-day horizon, which holds about 465. 
*_Expected:_* the requirement shows the *full* quantity ordered, marked {*}Short{*}, recording how many units cannot be covered. It is never quietly reduced. 
*_Why:_* a requirement cut down to what fits looks achievable and hides the gap.

*CASE-9 — Even a demand that cannot be started at all is shown.* 
*_Setup:_* so little time remains that the 15-minute setup alone will not fit. 
*_Expected:_* a requirement is still created, for the whole quantity, entirely unmet. 
*_Why:_* dropping the row would remove the demand — and everything beneath it — from the plan.

*CASE-10 — A component's minimum order quantity does not inflate what is made.*

_{*}Setup{*}:_ stickers {{{}DCSPPUSA{}}}, whose supplier SUP_003 requires 500, needed by a demand for far fewer.

_{*}Expected{*}:_ the purchase is raised to 500, because that is the smallest order the supplier accepts. What is *made* does not follow it — the production requirement stays at what demand and capacity justify, and the balance of the stickers is recorded as stock available to later demands.

_{*}Why{*}:_ a purchasing term constrains buying, not building. Raising a production requirement to meet a component's minimum would manufacture goods no demand asked for. See CASE-22 for the same minimum viewed from the purchasing side.

*CASE-11 — Work that cannot finish inside the horizon books nothing.*

*_Setup:_*
A demand whose work cannot complete before the horizon ends however it is placed.
*_Expected:_*
No machine time is reserved and the requirement carries its full quantity as unmet. Its dates run from the moment its machine next has time — not from the start of the run, and never across hours another order already holds. Where the window is full throughout, that moment falls beyond the window.
*_Why:_*
Reserving hours for work that cannot happen denies them to work that can. And a date anchored to the run's own start says the order could begin today when the machine is committed for the whole window — which reads as two orders starting together on one machine.

*CASE-12 — A machine waiting for parts is held, not given away.* 
*_Setup:_* a high-priority order that cannot start until its veneers arrive at midday, on an otherwise empty machine. 
*_Expected:_* the morning is held. A lower-priority order is not planned into hours the waiting order will occupy.

*CASE-13 — A small job may use that idle morning; a large one may not.* 
*_Setup:_* continuing CASE-12, two candidates — one that would finish before midday, one that would not. 
*_Expected:_* the small one runs in the gap; the large one is planned after the waiting order. Neither is split around it, and the waiting order does not move. 
*_Why:_* splitting a job means setting the machine up twice for one setup's worth of planned time.

*CASE-14 — Two orders due the same day: the later one finishes where the earlier one starts.*

*_Setup:_*
Two sales orders for the finished deck on the same day, with stock at every level below so only machine time binds: 60 units due 16:00 and 50 units due 16:30. At 15 minutes setup plus 5 minutes a unit, that is 315 and 265 minutes of work against a 480-minute shift.

*_Expected:_*
The 60-unit order is planned 10:45 to 16:00 — finishing exactly when it is due, not at 13:45. The 50-unit order cannot fit in the 30 minutes left after it, so it finishes at 10:45, where the first order begins, and reaches back into the previous day for the balance: 14:20 to 16:30 there, then 08:30 to 10:45 on the due day. Both keep their full quantity and neither is late. Thirty minutes of the due day are left unused.

*_Why:_*
Finishing when due rather than as early as possible is what keeps finished stock off the shelf. The second order shows the cost of never splitting a job honestly: the 30-minute remnant cannot be used by a 265-minute order, and the plan accepts that idle half-hour rather than breaking the order in two and paying its setup twice. It also shows that reaching into an earlier day takes the END of that day, so the work is one unbroken block across the overnight break rather than two pieces with a day between them.

*CASE-15 — A run whose last machine step is finished still counts as supply.*

*_Setup:_*
An open production run for the finished deck with 60 units still to produce, whose LAM step is marked finished, leaving only the machine-less trim. Demand for 300 units.

*_Expected:_*
A requirement for 240 units — the 60 still owed by the run are credited as supply, dated from the run's own estimated finish. Marking the LAM step finished must not change the number.

*_Why:_*
Supply is owed output, not reserved machine hours. Before this was fixed, finishing the last machine step made the run's remaining units disappear from the plan and the requirement jumped from 240 to 300, so a run looked further from delivering precisely because it had got closer.

*CASE-16 — Two orders for one product on one machine do not share a start date.*

*_Setup:_*
Two approved sales orders for the deck {{DSK15144-00}} at MFG_PLANT, no production runs and stock at every level below, so machine time is the only constraint. 400 units due today at 16:30, and 50 units due the following Friday at 16:30. A six-day window over LAM's Mon/Wed/Fri calendar, so three working days.

*_Expected:_*
The earlier-due order is sized to what the window holds and takes all of it, keeping its full 400 with the balance unmet. The later-due order can be given nothing: 50 units, wholly unmet, both orders Late and Short. Their start dates differ — the second is dated from when LAM next has time, after the first order's committed window, and its finish does not precede the first order's.

*_Why:_*
Capacity claimed by an earlier demand is gone, so a later one has to be dated somewhere else. Two identical start dates say both orders begin together on one machine, and a blocked order finishing before the order that took the capacity inverts the reading entirely. Both figures were right — only the dates were wrong, and wrong in the optimistic direction.

*_Note on the arithmetic:_*
Buildable quantity depends on the hour the run is submitted, because the first day is trimmed to the shift time still ahead of it. A run at 08:30 has 1,440 minutes over three days and builds 285; a run at 16:05 has 984 and builds 193. Derive the expected figures from the capacity remaining at the run instant rather than assuming a start-of-day run.
h2. B. Calendars, shifts and dates

*CASE-17 — A run started late in the day.* 
*_Setup:_* the plan is run at 16:46, after LAM's 16:30 close. 
*_Expected:_* nothing is planned into that day; the first work lands on the next day LAM works. Run at 15:00 instead, only the remaining 90 minutes are available. 
*_Why:_* hours that have already passed are not capacity.

*CASE-18 — Work spanning a shift close and non-working days.* 
*_Setup:_* 10 hours of deck work starting Monday morning on LAM, which works Monday, Wednesday and Friday. 
*_Expected:_* 8 hours Monday and the remaining 2 from Wednesday's opening. Work never lands in the evening or on a day the machine does not run.

*CASE-19 — Supplier lead time is counted in working days.* 
*_Setup:_* cross-ply veneer {{DRVM60361050XA}} with {{standardLeadTimeDays}} set to 7 on supplier SUP_001. 
*_Expected:_* the arrival date is that many of the *supplier's working* days ahead, so it lands later than a plain calendar count, and the same date decides whether the shortage is a delay or a cap.

*CASE-20 — Holidays and shutdowns count on every date, inside the window and outside it.*

*_Setup:_*
A machine working Monday, Wednesday and Friday, with an exception day recorded against its calendar closing it for a week. Demand needing several days of that machine, run so that the work reaches back before the run date and forward past the planning window.

*_Expected:_*
Both the achievable dates and the ideal need dates step over the closed week and over the non-working weekdays. The number of days walked back matches the machine's real working pattern, not a count of calendar days.

*_Why:_*
A calendar means the same thing whichever side of the planning window a date falls on. Previously the window was expanded from the real calendar — exception days included — while anything outside it used a working week inferred from that window, which silently dropped holidays and shutdowns and treated a three-day-a-week machine as working seven. The effect was to walk back too few days and report parts as needed _later_ than they truly were, understating how late an order already was.
h2. C. Stock and purchasing

*CASE-21 — What is already coming is counted before anything is proposed.* 
*_Setup:_* {*}SO-400{*}, plus {*}PO-50{*}, *PR-OPEN* and *REQ-INT-50* — 150 units already coming. 
*_Expected:_* the plan proposes {*}250{*}, not 400. Each source is dated when it can genuinely be there.

*CASE-22 — Supply reduces a requirement even when no machine is free.* 
*_Setup:_* demand for 50 decks, 50 already arriving, LAM fully booked. 
*_Expected:_* no requirement is raised. Using stock that already exists needs no machine time.

*CASE-23 — A covered level pulls no components.* 
*_Setup:_* *SO-100* covered entirely by approved shop orders for the same 100 units. 
*_Expected:_* no deck, sticker, warranty-card or transfer demand is raised beneath it. 
*_Why:_* ordering deck veneers for skateboards nobody will build wastes money and consumes the deck supply.

*CASE-24 — Stock is counted once.* 
*_Setup:_* *STK-DECK-40* against demand for 100 decks. 
*_Expected:_* a requirement for *60* — never 20 (counted twice) and never 100 (not counted).

*CASE-25 — A part that arrives in time delays; one that cannot caps the quantity.* 
*_Setup:_* *STK-VENEER-10* and deck demand for 100, run with a 30-day horizon. Cross-ply veneer arrives in 7 working days; core veneer takes 45 and cannot arrive inside the window. 
*_Expected:_* the cross-ply and face veneers are ordered and the decks simply wait for them, flagged late. The core veneer caps production at the 10 units on hand — 3 per deck, so 3 decks — and the shortage is recorded against it. 
*_Why:_* a part that arrives late is a scheduling problem; a part that cannot arrive at all is a hard limit on what the factory can promise.

*CASE-26 — A minimum order quantity's surplus becomes usable stock.* 
*_Setup:_* two small demands for stickers {{{}DCSPPUSA{}}}, minimum order 500. 
*_Expected:_* one order for 500, not two. The surplus is treated as stock the second demand consumes.

*CASE-27 — A purchase that should already have been placed.* 
*_Setup:_* the same 7-day part, needed sooner than 7 working days from now. 
*_Expected:_* the purchase starts {*}now{*}, is flagged late, and cannot arrive before its computed date.
h2. D. Priority and firm commitments

*CASE-28 — Priority classes decide who is served first.* 
*_Setup:_* on one day, deck demand from a sales order, from {*}PR-OPEN{*}, from {*}REQ-INT-50{*}, and from the 50-unit minimum stock level — together more than LAM can make. 
*_Expected:_* served in that order regardless of their dates, each taking only what the class above leaves. The stock top-up absorbs the shortfall. 
*_Why:_* a customer order should not lose machine time to a stock top-up that could wait.

*CASE-29 — Approved requirements survive and count as supply.* 
*_Setup:_* *REQ-PROD-50* and *REQ-INT-50* exist, approved, when the run starts. 
*_Expected:_* neither is deleted, both reduce what is proposed, and the approved shop order also takes its machine time. 
*_Why:_* approving is how a planner locks part of the plan; a rerun must not undo it.

*CASE-30 — An approved shop order's parts become demand.* 
*_Expected:_* its components are demanded at its own priority — above stock top-ups, below work already on the floor — due when the order itself is due.

*CASE-31 — Forecast is planned last.* 
*_Expected:_* forecast demand is planned after every other class and consumes only what they leave, ordered within itself by period.
h2. E. Multi-level products

*CASE-32 — A late deck pushes the skateboard.* 
*_Setup:_* a sales order for finished skateboards where the decks cannot be made in time. 
*_Expected:_* the decks take the first capacity available and the skateboards are moved to start at or after the decks are finished. Both are flagged late.

*CASE-33 — A skateboard never starts before its decks exist.* 
*_Expected:_* for every finished-goods requirement in the plan, its start is at or after the *receipt* of the deck batch feeding it — the moment the units that genuinely land are ready — and not only for the flagged ones. Where that receipt falls outside the consuming machine's working hours, the start rolls forward to the next moment that machine can work.

_The floor is the receipt, not the requirement's required-by date._ Those are different dates and deliberately so: a required-by date covers the *whole* order including units that are never made, while a receipt covers only what actually arrives. A level can consume only what arrives, so flooring it on the whole-order date would hold it back for units that will never exist.

*CASE-34 — Jobs on a group run side by side.*

*_Setup:_* a group of two 8-hour machines, one of them already committed for a full day.

*_Expected:_* a new job runs *that same day* on the free machine, at that machine's pace — not queued behind the committed one. A third job finds both machines full and moves to the previous working day.

*_Why:_* two machines can genuinely run two jobs at once. Reporting the second as queued understated what the plant could deliver and dated it later than reality.{*}{{*}}

*CASE-35 — A job too big for one machine is divided, and pays a setup per piece.*

_{*}Setup{*}:_ a job needing 12 hours on a group of two 8-hour machines, with only that day available.

_{*}Expected{*}:_ divided between the two machines — no single machine can deliver it that day — with each piece carrying its own setup, so the plan consumes slightly more machine time than the job's 12 hours. Both pieces run concurrently and the job is delivered on time. A job whose per-unit rate is not on file is *not* divided: a piece of it could not be costed, so it stays one block and takes the delay.

_{*}Why{*}:_ the second setup is real and the plan must charge it. The alternative — spreading every job over every machine — would pay that setup on jobs that never needed it and would leave no machine free for the next job.

*CASE-36 — A late part in one branch does not stall another.* 
*_Setup:_* cross-ply veneer delayed by its lead time, while stickers and warranty cards are in stock. 
*_Expected:_* only the levels that actually consume the late veneers are pushed out.

*CASE-37 — Two orders wanting the same part.* 
*_Setup:_* *SO-PAIR-1* and *SO-PAIR-2* — 50 each, decks needed the same day. 
*_Expected:_* each is planned through its own tree; they compete for the same veneers and the same LAM hours in priority order, and whichever is served second waits and is flagged late.
h2. F. Machine groups

*CASE-38 — A group pools its members' hours.* 
*_Setup:_* a group of two 8-hour machines, one of them already committed for a full day. 
*_Expected:_* a new job is planned into the remaining pooled hours; a further job finds the day full and moves to the previous working day.

*CASE-39 — A job spreads across the group.* 
*_Setup:_* a job needing 12 hours where 16 pooled hours are free. 
*_Expected:_* planned entirely within that day, elapsing 6 hours of clock time.

*CASE-40 — Members with different working weeks.* 
*_Setup:_* a group whose members work Monday–Friday and Monday/Wednesday/Friday respectively, on a Tuesday. 
*_Expected:_* the group offers one machine's shift that day — 8 hours of work in 8 hours — not half of two.

*CASE-41 — A step naming one machine.* 
*_Expected:_* it runs at that single machine's pace, its hours come out of the group's pool so nothing else can claim them, and a second step naming the same machine is pushed out even though the group still shows capacity — because that capacity belongs to the other machine.
h2. G. Routing steps

*CASE-42 — A step with a time but no machine.* 
*_Setup:_* the deck routing's "Shape Deck" step, which has no machine assigned. 
*_Expected:_* it contributes its time to the schedule but consumes no machine capacity, and a later job on LAM sees only the LAM step's hours taken.

*CASE-43 — A step with a machine but no times, and a step with neither.* 
*_Expected:_* both are effectively instantaneous and neither limits the quantity. _Why:_ this is existing OFBiz arithmetic and must not change.
h2. H. Dates, flags and modes

*CASE-44 — The required-by date covers the whole order.* 
*_Setup:_* a run that can make only part of its quantity. 
*_Expected:_* its required-by date is when *all* of it would be finished, even past the horizon, while the receipt is dated when the units that genuinely land are ready. The receipt is also the date a consuming level is floored on, so a level starts when its parts genuinely arrive rather than when the order that produced them notionally completes — see CASE-33.

*CASE-45 — Every requirement records the date it was measured against.* 
*_Expected:_* present on every requirement, flagged or not — the order's own date for a finished good, the consuming step's start for a component.

*CASE-46 — No date is ever set in the past.* 
*_Expected:_* no requirement starts before the moment the run began, under any combination of overdue supply, late purchases and elapsed shifts.

*CASE-47 — Lateness is flagged where it happens and carried upward.* 
*_Expected:_* each delayed batch carries its own flag, so a delayed deck is visible to whoever schedules LAM, and the finished skateboard is late if anything feeding it was.

*CASE-48 — Both plans coexist.* 
*_Expected:_* a constrained and an unconstrained run each keep their own results; re-running one leaves the other and every approved requirement untouched, so the two can be compared side by side.

*CASE-49 — The existing MRP is unaffected.* 
*_Expected:_* with the constrained mode unused, results are identical to the current release.
h1. What the plan does not attempt
 * *Optimizing the order of work within a day.* The plan does produce a sequence — every job carries a start and finish time, and jobs queue behind one another on a machine — but that order follows planning priority. It is not rearranged to reduce changeovers, and sequence-dependent setup times are not modelled, so a scheduler may still improve on it.
 * *Naming which machine in a group.* Because a job spreads across the group's machines, the plan cannot say which one it runs on.
 * *Carrying a shortfall onto a later order.* None is needed — the shortfall stays visible on the requirement that could not cover it.
 * *Part-finished operations.* A step half way through is treated as not started, because the data records no partial progress per step. This overstates the time left rather than understating it.
 * One facility per run; the plan is rebuilt in full each time rather than adjusted.
 * Alternative machines and routings, and lot sizing beyond a minimum order quantity, are not modelled.
 * *Merging demands for the same product into one requirement.* Deliberate: separate requirements are what let every batch be traced to the order it serves. It does mean more rows than a consolidating planner would produce, and that a setup is charged per requirement rather than once for a combined batch.
 * *Exception WEEK patterns.* {{TechDataCalendarExcDay}} — individual holidays, shutdowns and one-off closures — is honoured on every calendar the plan walks. {{{}TechDataCalendarExcWeek{}}}, a temporary replacement week pattern, is not. This is inherited: stock OFBiz honours neither, and the classic unconstrained run ignores exception days entirely.
 * *Exception days on the purchasing and shipping legs.* Supplier lead time is walked through the supplier's own calendar and the outbound leg through the facility's SHIPPING calendar, each correctly separate from the machine's — a machine down for maintenance does not close the goods-in dock. But those two walks use the stock OFBiz calendar helpers, which do not read exception days, so a supplier's own works holiday does not extend its lead time. Inherited rather than introduced, and only visible where supplier or shipping calendars carry exception days.

h1. Behavior proven below the case level

Two rules are enforced but cannot be exercised through an MRP run's output, because reproducing them needs control of the system clock or of internal state rather than of data. They are covered by unit tests and are recorded here so they are not mistaken for gaps:
 * *Day buckets across a daylight-saving change.* Each bucket maps to a real local day; a local day of 23 or 25 hours does not make later buckets drift.
 * {*}A completion never precedes its own start{*}, and work never lands in an evening or on a non-working day, whatever the calendar arithmetic is asked to walk.
 * *A lone order on a group reports a later finish.* It no longer runs at the group's summed rate. Two presses, 15 min setup, 5 min/unit, 93 decks = 480 minutes of work: previously 08:30→12:30, now 08:30→16:30. The old 12:30 was only achievable by running the batch on both presses at once — two operators and *two* setups — which the plan neither instructed nor charged for. Where the due date is tight the order is divided and the answer is close to the old one, with the second setup counted. So the later date appears only where there was slack to absorb it.
 * *Some plans gain a setup.* 93 decks divided 47/46 is 250 + 245 = 495 minutes against 480 whole.
 * *Two same-day orders now overlap instead of queueing.* Both still finish at the same moment the plant would have managed before — total throughput is unchanged — but the second no longer waits, and an order that previously read late may now be delivered.
 * *Ideal need dates lengthen on a group.* Ideal dates were computed against the group's summed calendar, a rate the finite plan never uses. They are now measured on one machine, matching how the work runs. Component need dates come from the ideal schedule, so this affects reported component shortages.

h1. Not yet implemented - Candidate for Next Phase 
 * *Simulated and Promote.* Requirements from the non-default mode should be created as {{REQ_SIMULATED}} with no route to Approved, and a permission-controlled, audited *Promote* should swap which plan is approvable. The data model supports this; the behaviour does not exist yet.
 * Late and Short context is not carried onto a production run when a requirement is converted.
 * The explanation of what limited a demand appears in the run's messages, not on the requirement.
 * {*}A declared maximum number of splits per routing step{*}, for a shop that needs an order divided even when one machine could deliver it. 
 * *Recording which machine on the production run* created from a requirement. {{Requirement}} has no fixed-asset field and the assignment is internal to capacity planning, so the machine is not persisted.
 * *A separate capacity-levelling pass* — balancing across the whole order book and re-sequencing to close gaps. This is what every vendor provides as a second step, and what an APS-style opportunistic split would require. Deliberately out of scope: this engine plans one order at a time in priority sequence and never re-plans a placed order.
 * *Piece-to-piece pipelining* between routing steps: where step 1 is divided, step 2 chains on the latest piece's finish rather than being fed by the first piece to complete.
---

---
### Ticket 2 — OFBiz OFBIZ-4938
**Link:** https://issues.apache.org/jira/browse/OFBIZ-4938
**Summary:** Add process to remind sales invoice not paid
**Description:**
When a sale invoice have due date in past and not paid, add process to remind the customer by a letter.
---

---
### Ticket 3 — OFBiz OFBIZ-5412
**Link:** https://issues.apache.org/jira/browse/OFBIZ-5412
**Summary:** Add ability to change ship estimate for purchase orders
**Description:**
OFBiz should be improved to allow the ship estimate to be changed for existing purchase orders.  The ship estimate value is able to be set during the entry phase of the order by not no form exists for changing the value once the order is created.  The shipping and handling cost will have to be recalculated if the ship estimate value changes.
---

---
### Ticket 4 — OFBiz OFBIZ-9170
**Link:** https://issues.apache.org/jira/browse/OFBIZ-9170
**Summary:** Department wise Trial balance in an internal organization 
**Description:**
Dear Support team,
Want to configure one internal organization and multiple Trail Balance based on the departments ( which will help to get dept wise Balance sheet and P&L ), is this possible to achieve in ofbiz with the default functionalities. 
Please help 

Regards, 
Velu
---

---
### Ticket 5 — OFBiz OFBIZ-10974
**Link:** https://issues.apache.org/jira/browse/OFBIZ-10974
**Summary:** Stock Watch List Report
**Description:**
Add the Stock Watch List report to track the availability of items and assortment. So that sales manager can keep a watch on current stock and sales performance of all the product lines and can get their current inventory status like Available, Low, Out of Stock and when the inbound shipment is planned to receive. This information can help merchandiser to analyse differentiation in fast moving and slow moving items.      

Report should have following filters : 
 * User should be able to filter the report by availability status like Available, Highly Available, Low, Out of Stock items.
 * User should be able filter the products by category.
 * User should be able to choose all or any of these filters to generate the report.

Report Matrix should be-

lets say we have to product X in category Y in system that have multiple variants like product-X has following size variants XS, S, M, L, XL in RED colour.. And it also have same size variants in BLUE colour..then resultant report should be like this..
||Product Name||XXS||XS||S||M||L||XL||
||Product-X (RED)||A||A+||L
<incoming shipment Date>||O||A||A||
||Product-X (BLUE)||L||A||A+||A||O||L
<incoming shipment Date>||

 

Availability Codes: 

*(A) - Available*  _i.e_. product has more number of quantity then safety stock.

*(A+) - Highly Available* _i.e_ product has more number of quantities than max limit. 

*(L) - Low* _i.e._ product has less quantity than safety stock.

*(O) - Out of Stock*  _i.e_ product is not in stock.

 

Tagging [~swash78]
---

---
### Ticket 6 — OFBiz OFBIZ-12141
**Link:** https://issues.apache.org/jira/browse/OFBIZ-12141
**Summary:** Add support for Romania
**Description:**
I would like to add support for Romania to OFBiz: provinces, taxes and the rest.
---

---
### Ticket 7 — OFBiz OFBIZ-12411
**Link:** https://issues.apache.org/jira/browse/OFBIZ-12411
**Summary:** Generated requirments should also have a PDF support
**Description:**
In many businesses PDFs can be handy to compare or make decisions.

We can add feature to have a PDF for the generated requirements.
---

---
### Ticket 8 — Atlas ATLAS-4501
**Link:** https://issues.apache.org/jira/browse/ATLAS-4501
**Summary:** Table 'Allow list' with a default deny to load only a subset of tables
**Description:**
There are some huge environments where the warehouse has a thousand databases and hundred thousand tables with many columns and most of them are dropped, created, updated at a fast pace. In these environments, the Atlas processing time can slow down increasing the backlog as it starts moving slower than the changes in the warehouse and the {{prune.pattern}} e/o {{ignore.pattern}} it is not suitable.

It will be nice to have the opportunity to have a default deny behaviour for all the tables and then to 'allow' the import of a subset of tables specified in a parameter regex (in order to process only some important tables): basically that works in the opposite way to the {{prune.pattern}} and {{ignore.pattern.}}

As far as I know, there is a similar feature for S3 and ADLS but not for hive.
If this is the case, will be nice to get the feature onboarded in your backlog.
---

---
### Ticket 9 — Atlas ATLAS-2973
**Link:** https://issues.apache.org/jira/browse/ATLAS-2973
**Summary:** UI - Attribute mass update
**Description:**
Similar to setting Tags to all objects in the list , it should be possible to set all to all objects a given attribute. As a precondition,the list may only contain objects of a single type

Example: Set the "owner" attribute of all hive_table objects that match a specific search function
---

---
### Ticket 10 — Atlas ATLAS-1764
**Link:** https://issues.apache.org/jira/browse/ATLAS-1764
**Summary:** Design and implement Atlas Collections
**Description:**
Design and implement Atlas Collections - A first class element in Atlas to group related entities together and perform operations on these collections - associate tags, add/remove entities...

Operations:
---------------
    a. Create collection(s) with attributes, constraints
    b. Update existing collection(s)
    c. Delete collection(s) - soft delete, hard delete
    d. Retrieve collections by id, name
    e. Add entity(s) to collection(s)
    f. Remove entity(s) from collection(s)
    g. Associate classification(s) to collection(s)
    h. Disassociate classification(s) from collection(s)
---

---
### Ticket 11 — Atlas ATLAS-1055
**Link:** https://issues.apache.org/jira/browse/ATLAS-1055
**Summary:** Allow Term relationships to be defined 
**Description:**
It should be possible to create relationships between terms. This should include:
- "has a" relationships ( like the composition ones between assets)
- aggregation relationships 
- directional relationships (a reference)
-bidirectional relationships (for me this is the lowest priority as it is likely to more involved)

Like ALTAS-1054 is should be possible to map relationships to assets starting with the simplest case of the directional relationship.
---

---
### Ticket 12 — Atlas ATLAS-1054
**Link:** https://issues.apache.org/jira/browse/ATLAS-1054
**Summary:** Allow Terms rather than assets to be the primary entities in the API and UI.
**Description:**
I see that ATLAS-812 allows the user to associate terms with Assets. 

For governance use cases a natural way is to work with terms and assets is to work with the business glossary terms as the primary entities both in the Ui and in the REST API. 

I suggest the user be allowed :
- find the term of interest and then associate it with an asset
- be able to view terms and their associated assets in one REST GET term call. I suggest returning the assets as a subobjects (I suspect we will want to have a inquirylevel where 1 would just return the terms , and 2 would include subobjects.
- allow classifications to be specified against the terms.  I would like to see more intuitive words like term, asset and classification rather than tag , trait or trait name in the UI and API.
---

---
### Ticket 13 — Atlas ATLAS-55
**Link:** https://issues.apache.org/jira/browse/ATLAS-55
**Summary:** Search Query Editor with syntax highlighting and autocomplete
**Description:**
To make it easier for users to do a DSL query,  we could add support for a query editor which does syntax highlighting and autocomplete for types, traits ..for eg: if user types from, we could display autocomplete list of types and when he types "is", could do an autocomplete for traits.

Syntax highligting will help users to detect syntax errors while typing instead of firing the query and then finding some issue with the query.
---

---
### Ticket 14 — Atlas ATLAS-1962
**Link:** https://issues.apache.org/jira/browse/ATLAS-1962
**Summary:** User/group mapping rules similar to Hadoop's auth_to_local
**Description:**
Feature Request to add user/group mapping rules similar to Hadoop's auth_to_local.

This will allow munging users/groups and rule based remappings to differentiate duplicate users in multi-domain Active Directory forests where the LDAP results returned from the global catalog include duplicate usernames which need to be translated with a prefix/suffix in order to differentiate between domains to prevent users from different domains sharing logins, permissions etc.
---

---
### Ticket 15 — Fineract FINERACT-1944
**Link:** https://issues.apache.org/jira/browse/FINERACT-1944
**Summary:** interest recalculation only when client pays early - do not recalculate if payment is on time or late (so that interest remains the same)
**Description:**
As a client of a financial institution i would like to see the following among others for my loan
 * *Interest Method: Declining Balance*
 * *Interest recalculation: Enabled* - When I pay my installments before due date,  the system should follow the standard of recalculating my interest downwards. When I pay late the system does not recalculate (or lets say it does but ignores updating my interest upwards.

[~ikimbrah] [~bgowda] is this a viable new feature?
---

---
### Ticket 16 — Fineract FINERACT-904
**Link:** https://issues.apache.org/jira/browse/FINERACT-904
**Summary:** Post Interest on Account Activation Date for Fixed Deposit and Recurring Deposit Accounts
**Description:**
Hello,

Presently for Savings Products (Savings/Fixed Deposit and Recurring Deposit) Fineract posts Interest at month end. There is a need for this to change in our use case (and I believe this may be widely applicable for multiple users).

Assuming a customer's Fixed Deposit or Recurring Deposit account is activated on Jan 20, we post interest to the customer's account on Feb 20 and on the 20th of every subsequent month until the duration of the account lapses. So for a 6 month Fixed Deposit Account interest would be posted on Feb 20, Mar 20, Apr 20, May 20, June 20 and July 20.

For "tricky" dates which don't occur across all months then interest is posted at the end of the month. So For example an account activated on January 30 will get Interest posted on Feb 28 (or Feb 29th for a leap year) and then Mar 30, April 30 etc. One that was activated on say August 31st will receive interest on Sep 30, Oct 31, Nov 30, Dec 31 etc.
---

---
### Ticket 17 — Fineract FINERACT-868
**Link:** https://issues.apache.org/jira/browse/FINERACT-868
**Summary:** Fineract interaction with external or third party applications
**Description:**
Fineract webhooks enable it to communicate or interact with external or third party services/applications. However, there are use cases where Fineract is being integrated or used along side third party services in which a certain functionality might need to be triggered in Fineract by and external service but Fineract currently only supports one way interaction (Fineract to external service through webhooks) but not vice versa (from external service to Fineract). 

 

Example use case: Fineract is used alongside a third party service which deals with money transactions. If user maybe wants to make a purchase or make money transfer and has 0 balance in his/her account, an option might be provided by the user's financial institution to transfer funds from the user's accounts in Fineract (if sufficient) or apply for a loan. This functionality of the third party application interacting with Fineract is usually done through webhooks and Fineract currently does not support interaction with external webhooks.
---

---
### Ticket 18 — Fineract FINERACT-687
**Link:** https://issues.apache.org/jira/browse/FINERACT-687
**Summary:** Automatic application of Late Penalty should not happen in certain scenarios
**Description:**
Currently, late penalty charges are applied automatically depending on chargeTime configuration if the loan is not closed. However, in following scenarios, we should be able to configure if late penalty should be applied or not:
1. Outstanding amount for Loan is within arrears limit
2. Loan is in NPA

As a workaround, these charges can be waived, but it reflect in accounting journals which is not desired.

Also, there are regulatory requirements stating sum of all charges levied on loan cant be greater than x%loan principal value.
---

---
### Ticket 19 — Fineract FINERACT-679
**Link:** https://issues.apache.org/jira/browse/FINERACT-679
**Summary:** Share Transfer And Distinctive Number 
**Description:**
Hi

As of now there is only the option of Redeeming the Shares back to the Company, but the members or the clients can Transfer the Shares to another person too. 

The option is missing.
Another major addition that needs to be built is the Distinctive numbers of the Shares

Persons holding the Shares of a firm will have the Share Certificate number and the Distinctive (Folio) Numbers

 Is it possible to develop that on the current Version ?
---

---
### Ticket 20 — Fineract FINERACT-134
**Link:** https://issues.apache.org/jira/browse/FINERACT-134
**Summary:** Add support for Revolving Line of Credit products
**Description:**
As part of the Q2 work on Flexible Loan Schedules phase 3, we should explore supporting a new product for a revolving line of credit. 

We have had requests from customer like the Paradigm Project for revolving lines of credit to purchase non-durable goods like solar cook stoves etc: http://www.theparadigmproject.org/

The primary difference between a revolving and non-revolving line of credit is that repayments on RLOC replenish the available credit balance, becoming available for borrowing again. See http://goo.gl/0itVoh
---

---
### Ticket 21 — James JAMES-2371
**Link:** https://issues.apache.org/jira/browse/JAMES-2371
**Summary:** Store attachments out of the database
**Description:**
I want to store email attachments on file system(directly or by calling a service to do it) and save only text part of the message body in database.
I know that in general, saving whole message body (including attachments) in database is better But due to certain circumstances, I have to do it. And it may be useful for others with limited storage space on database.
We can implement it as a configurable feature.
And if it is not accepted as a new feature, can anyone help me out how to do it?

Thank you
---

---
### Ticket 22 — Unomi UNOMI-813
**Link:** https://issues.apache.org/jira/browse/UNOMI-813
**Summary:** New endpoint to create / update / merge profiles
**Description:**
In Unomi 2, aliases were introduced to make it easier to work with several identifiers for one profile. 
However there is no endpoint to create a profile using an external identifier. Improving the current endpoint to create profile or creating a new one would be helpful for organizations looking to create profils using CRM ids, customers ids etc.. 

Such endpoint:
- Cannot not be public for security reasons, it would need to be added to /cxs/.. 
- Would cover creation or update of profiles by external systems. If the profile is updated by the visitor, this still needs to happen through events
- Shouldn't be able to force the value of the profile id. Profile ids need to stay secure and it's better to have unomi generate them
- Would require an alias in the payload. Likely: alias id + alias property (examples: john@smith.com, email or johnSmith, login)
- Would trigger the merge logic, for data consistency reasons 

h3. Limitation / to keep in mind: 
In a better world, it might make more sense to restrict the creation and updates of profiles/ sessions through events. 
In that case, we might need to support a new event type: createOrUpdateProfile 

This event type would not be public, it would be restricted as login and updateProperties

Warning: To send process an event, unomi needs a profile id. However, in that case, there wouldn't be any. That is why it might be better after all to allow the creation of profiles from private endpoints. Otherwise, we'd need to make sure that unomi can process this event type without any profile id.
---

## Extraction Log
- None. All 22 ticket pages loaded successfully, all Ticket IDs matched, and no Description fields were empty or missing.
