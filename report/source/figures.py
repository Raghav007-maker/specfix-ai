"""Every diagram in the report, as an SVG string keyed by figure id."""
from svg import (Svg, NAVY, BLUE, LBLUE, GREEN, DGREEN, ORANGE, DORANGE, GREY, DGREY, PURPLE, DPURPLE)


def _layer(s, y, h, title, items, fill, stroke, ifill="white", size=12.5):
    s.box(10, y, 700, h, (), fill=fill, stroke=stroke, rx=8)
    s.text(22, y + 19, title, 13.5, "bold", NAVY, anchor="start")
    n = len(items)
    gap = 10
    avail = 676
    bw = (avail - gap * (n - 1)) / n
    for i, it in enumerate(items):
        x = 22 + i * (bw + gap)
        s.box(x, y + 28, bw, h - 38, it, fill=ifill, stroke=stroke, size=size)


def architecture():
    s = Svg(585)
    _layer(s, 8, 98, "Presentation layer — Next.js 15 + React 19 dashboard (apps/web)",
           [["Login &", "Onboarding"], ["Review", "Queue"], ["Ticket Review", "(flags, audit)"],
            ["Specs Tab", "(scenarios,", "scaffolds)"], ["Coverage &", "Drift views"]], LBLUE, BLUE)
    _layer(s, 124, 88, "Application layer — server actions, session and tenant resolution",
           [["Supabase Auth", "session"], ["requireTenant()", "org switch"], ["Server actions", "decide / compile"],
            ["ops CLI", "scripts/ops.ts"], ["eval CLI", "packages/eval"]], GREY, DGREY)
    _layer(s, 230, 112, "Domain packages — TypeScript npm-workspaces monorepo",
           [["@specfix/ingest", "Markdown, JSON,", "CSV tickets"], ["@specfix/core", "Extractor, Critic,", "embeddings, cost"],
            ["@specfix/compiler", "Gherkin compile,", "scaffold emitter"], ["@specfix/eval", "gold sets, metrics,", "random control"],
            ["@specfix/shared", "zod schemas,", "hashing, clauses"]], ORANGE, DORANGE, size=12)
    _layer(s, 360, 80, "Data-access layer — @specfix/db repositories (tenantId is always the first argument)",
           [["tickets"], ["flags"], ["labeling"], ["scenarios"], ["scaffolds"], ["traceability"], ["embeddings"]],
           PURPLE, DPURPLE, size=12)
    s.box(10, 458, 700, 120, (), fill=GREEN, stroke=DGREEN, rx=8)
    s.text(22, 477, "Infrastructure", 13.5, "bold", NAVY, anchor="start")
    s.cylinder(30, 488, 210, 80, ["Supabase PostgreSQL", "pgvector (HNSW)", "Row-Level Security"], fill="white", stroke=DGREEN, size=12.5)
    s.box(258, 490, 230, 78, ["Azure OpenAI / OpenAI", "gpt-4o-mini, gpt-5.4-mini", "text-embedding-3-small"], fill="white", stroke=DGREEN, size=12.5)
    s.box(506, 490, 190, 78, ["GitHub Actions CI", "pgvector/pg16 service,", "lint, typecheck, tests"], fill="white", stroke=DGREEN, size=12.5)
    for y1, y2 in [(106, 124), (212, 230), (342, 360), (440, 458)]:
        s.line([(360, y1), (360, y2)], width=2)
    return s.render()


def dfd0():
    s = Svg(470)
    s.circle(360, 235, 92, ["0", "SpecFix", "Requirement", "Analysis System"], fill=LBLUE, size=15.5)
    ents = {
        "src": (20, 30, ["Ticket Source", "(Markdown / JSON /", "CSV; Jira planned)"]),
        "pm": (520, 30, ["Product Manager /", "Reviewer"]),
        "llm": (20, 370, ["LLM Service", "(Azure OpenAI)"]),
        "te": (520, 370, ["Test Engineer /", "Developer"]),
        "ev": (270, 400, ["Evaluator /", "Team Lead"]),
    }
    for k, (x, y, ln) in ents.items():
        s.box(x, y, 180, 64, ln, fill=GREY, stroke=DGREY, rx=2, size=14.5)
    s.line([(200, 62), (290, 165)]); s.label(250, 100, "raw tickets", anchor="start", size=14)
    s.line([(430, 175), (530, 94)]); s.label(470, 112, "flags +", anchor="end", bg=False, size=14)
    s.label(470, 127, "PM questions", anchor="end", bg=False, size=14)
    s.line([(585, 94), (448, 210)], dash="5 3"); s.label(560, 150, "decisions, gap", anchor="start", bg=False, size=14)
    s.label(560, 165, "lists, sign-off", anchor="start", bg=False, size=14)
    s.line([(285, 290), (175, 370)]); s.label(232, 352, "ticket text,", anchor="start", bg=False, size=14)
    s.label(232, 367, "prompts", anchor="start", bg=False, size=14)
    s.line([(80, 370), (275, 265)], dash="5 3"); s.label(60, 300, "schema-valid JSON,", anchor="start", bg=False, size=14)
    s.label(60, 315, "embeddings", anchor="start", bg=False, size=14)
    s.line([(440, 285), (550, 370)]); s.label(510, 300, "Gherkin scenarios,", anchor="start", bg=False, size=14)
    s.label(510, 315, "Playwright scaffolds", anchor="start", bg=False, size=14)
    s.line([(375, 326), (375, 400)]); s.label(384, 372, "eval reports", anchor="start", bg=False, size=14)
    s.line([(340, 400), (340, 330)], dash="5 3"); s.label(334, 394, "gold sets", anchor="end", bg=False, size=14)
    return s.render()


def dfd1():
    s = Svg(560)
    s.box(10, 8, 200, 40, ["Ticket Source"], fill=GREY, stroke=DGREY, rx=2, size=13)
    s.box(260, 8, 200, 40, ["LLM Service"], fill=GREY, stroke=DGREY, rx=2, size=13)
    s.box(510, 8, 200, 40, ["PM / Reviewer"], fill=GREY, stroke=DGREY, rx=2, size=13)
    P = {1: (110, 140, ["1.0", "Ingest &", "Version Ticket"]),
         2: (360, 140, ["2.0", "Analyze:", "Extractor + Critic"]),
         3: (610, 140, ["3.0", "Human Review", "& Sign-off"]),
         4: (610, 390, ["4.0", "Compile Specs", "(Gherkin+Scaffold)"]),
         5: (360, 390, ["5.0", "Traceability &", "Embeddings"]),
         6: (110, 390, ["6.0", "Evaluate &", "Report"])}
    for k, (x, y, ln) in P.items():
        s.circle(x, y, 62, ln, size=12.5)
    s.line([(110, 48), (110, 78)]); s.label(116, 68, "files", anchor="start", bg=False, size=13)
    s.line([(345, 48), (345, 79)], start_arrow=True); s.label(352, 68, "prompts / JSON", anchor="start", bg=False, size=13)
    s.line([(610, 48), (610, 78)], start_arrow=True); s.label(616, 68, "flags / decisions", anchor="start", bg=False, size=13)
    s.store(10, 232, 200, 30, ("D1", "tickets / ticket_versions"), 12)
    s.store(260, 232, 200, 30, ("D3", "llm_calls (cost log)"), 12)
    s.store(510, 232, 200, 30, ("D2", "flags / flag_decisions"), 12)
    s.store(510, 482, 200, 30, ("D4", "scenarios / scaffolds"), 12)
    s.store(260, 482, 200, 30, ("D5", "embeddings / links"), 12)
    s.store(10, 482, 200, 30, ("D6", "gold sets / eval-runs"), 12)
    s.line([(172, 140), (298, 140)]); s.label(235, 131, "new version", size=13)
    s.line([(422, 140), (548, 140)]); s.label(485, 131, "open flags", size=13)
    s.line([(415, 170), (525, 232)])
    s.line([(575, 262), (575, 300), (595, 330)]); s.label(582, 300, "approved AC", anchor="start", bg=False, size=13)
    s.line([(575, 194), (575, 232)], arrow=False)
    s.line([(548, 390), (422, 390)]); s.label(485, 381, "accepted specs", size=13)
    s.line([(298, 390), (172, 390)]); s.label(235, 381, "coverage data", size=13)
    s.line([(110, 202), (110, 232)]); s.line([(360, 202), (360, 232)]); s.line([(650, 194), (650, 232)], start_arrow=True)
    s.line([(610, 452), (610, 482)]); s.line([(360, 452), (360, 482)]); s.line([(110, 452), (110, 482)], start_arrow=True)
    s.line([(150, 262), (318, 345)], dash="5 3"); s.label(214, 292, "version text", bg=False, size=13)
    s.text(360, 545, "Solid: process data flows · dashed: supporting reads · the LLM Service is also called by 4.0 and 5.0", 11.5, fill=DGREY, style="italic")
    return s.render()


def usecase():
    s = Svg(600)
    s.box(150, 8, 420, 584, (), fill="#FBFCFE", stroke=BLUE, rx=10)
    s.text(360, 30, "SpecFix System", 15, "bold", NAVY)
    left = [["Review flag: accept", "/ edit / dismiss"], ["Reopen a decision"], ["Blind gap labeling"],
            ["Mark ticket", "ready for dev"], ["Generate Gherkin", "scenarios"], ["Run analysis", "(Extractor + Critic)"],
            ["Ingest tickets"], ["Switch organisation"], ["Sign in / Create", "workspace"]]
    right = [["Review scenario"], ["Review scaffold,", "fill selectors"], ["Download scaffold", "(.spec.ts)"],
             ["View coverage", "& drift"], ["Run eval /", "compare arms"], ["View ops metrics", "(acceptance, cost)"]]
    ly = [60 + i * 62 for i in range(9)]
    ry = [90 + i * 74 for i in range(4)] + [430, 520]
    for y, ln in zip(ly, left):
        s.ellipse(262, y, 92, 25, ln, size=11.5)
    for y, ln in zip(ry, right):
        s.ellipse(462, y, 92, 25, ln, size=11.5)
    s.actor(60, 110, ["Product", "Manager"])
    s.actor(60, 400, ["Org Admin", "(Owner)"])
    s.actor(660, 130, ["Test", "Engineer"])
    s.actor(660, 430, ["Evaluator"])
    for y in ly[:5]:
        s.line([(78, 140), (170, y)], arrow=False, width=1)
    for y in ly[5:]:
        s.line([(78, 430), (170, y)], arrow=False, width=1)
    for y in ry[:4]:
        s.line([(642, 160), (554, y)], arrow=False, width=1)
    for y in ry[4:]:
        s.line([(642, 460), (554, y)], arrow=False, width=1)
    s.line([(60, 400), (60, 205)], arrow=True, head="tri", dash="4 3")
    s.label(66, 300, "generalises", anchor="start", bg=False, size=10.5)
    return s.render()


def classdiagram():
    s = Svg(650)
    b = {}
    b["Tenant"] = (2, 10, 145, ["id: uuid", "name: text", "monthly_token_cap"], [])
    b["Project"] = (192, 10, 145, ["id: uuid", "source_type", "jira_project_key"], [])
    b["Ticket"] = (382, 10, 145, ["external_key", "title, description", "content_hash"], ["ingestTicket()"])
    b["TicketVersion"] = (572, 10, 146, ["id: uuid", "content_hash", "acceptance_criteria", "captured_at"], ["latestVersion()"])
    b["Membership"] = (2, 215, 115, ["user_id", "role"], [])
    b["FlagDecision"] = (160, 215, 150, ["decision", "edited_text", "user_id, created_at"], [])
    b["Flag"] = (355, 215, 180, ["category, severity", "quoted_span", "question_for_pm", "status, origin", "critic_verdict"], ["decideFlag()", "precisionCounts()"])
    b["AnalysisRun"] = (580, 215, 138, ["prompt_version", "model, temperature", "status, truncated", "cost_usd"], ["recordAnalysis()"])
    b["LabelingSession"] = (2, 420, 170, ["stage", "gaps_locked_at", "revealed_at"], ["lockGaps()", "recallCounts()"])
    b["ReviewerGap"] = (2, 580, 170, ["description", "matched_flag_id"], [])
    b["Scenario"] = (355, 440, 180, ["title, gherkin_raw", "gherkin_original", "status, origin", "covers_ac"], ["decideScenario()"])
    b["TestScaffold"] = (580, 440, 138, ["framework, code", "selector_placeholders"], ["decideScaffold()"])
    b["TraceabilityLink"] = (200, 585, 140, ["link_type", "created_by"], [])
    b["Embedding"] = (420, 600, 200, ["vector(1536), model"], [])
    hs = {}
    for name, (x, y, w, at, op) in b.items():
        hs[name] = s.classbox(x, y, w, name, at, op, size=11.5)

    def assoc(p1, p2, l1="1", l2="*"):
        s.line([p1, p2], arrow=False, color=BLUE, width=1.3)
        if abs(p1[1] - p2[1]) < 2:
            sg = 1 if p2[0] > p1[0] else -1
            s.text(p1[0] + 5 * sg, p1[1] - 5, l1, 12, "bold", DORANGE, "start" if sg > 0 else "end")
            s.text(p2[0] - 5 * sg, p2[1] - 5, l2, 12, "bold", DORANGE, "end" if sg > 0 else "start")
        else:
            d = 1 if p2[1] > p1[1] else -1
            s.text(p1[0] + 6, p1[1] + d * 16 + (0 if d > 0 else 10), l1, 12, "bold", DORANGE, "start")
            s.text(p2[0] + 6, p2[1] - d * 8 + (0 if d > 0 else 10), l2, 12, "bold", DORANGE, "start")

    def r(n, dy=36):
        x, y, w, *_ = b[n]
        return (x + w, y + dy)

    def l(n, dy=36):
        x, y, *_ = b[n]
        return (x, y + dy)

    def t(n, dx=0.5):
        x, y, w, *_ = b[n]
        return (x + w * dx, y)

    def bo(n, dx=0.5):
        x, y, w, *_ = b[n]
        return (x + w * dx, y + hs[n])
    assoc(r("Tenant"), l("Project"))
    assoc(r("Project"), l("Ticket"))
    assoc(r("Ticket"), l("TicketVersion"))
    assoc(bo("TicketVersion"), t("AnalysisRun"))
    assoc(l("AnalysisRun", 50), r("Flag", 50))
    assoc(l("Flag", 50), r("FlagDecision", 50))
    assoc(bo("Tenant", 0.4), (58, 215))
    assoc(bo("Flag", 0.5), t("Scenario", 0.5), "*", "*")
    s.text(452, 418, "source_flag_ids", 11, fill=DGREY, anchor="start", style="italic")
    assoc(r("Scenario", 60), l("TestScaffold", 60))
    assoc(bo("LabelingSession"), t("ReviewerGap"))
    assoc(r("LabelingSession", 40), (355, 330))
    s.text(268, 400, "reveals flags", 11, fill=DGREY, style="italic")
    assoc(bo("Scenario", 0.15), t("TraceabilityLink", 0.75))
    assoc(bo("Scenario", 0.7), t("Embedding", 0.3), "1", "0..1")
    return s.render()


def sequence():
    s = Svg(680)
    parts = ["Reviewer", "Web UI /|Server action", "@specfix/core|deliberate()", "LLM|(Extractor)", "LLM|(Critic)", "@specfix/db|repositories", "PostgreSQL"]
    xs = [50, 152, 258, 362, 462, 565, 664]
    for x, p in zip(xs, parts):
        ln = p.split("|")
        s.box(x - 48, 8, 96, 44, ln, fill=NAVY, stroke=NAVY, size=12, tcolor="white", bold_first=False)
        s.line([(x, 52), (x, 672)], arrow=False, dash="4 4", color="#9aa4b1", width=1)
    y = [86]

    def msg(a, b, text, ret=False):
        yy = y[0]
        xa, xb = xs[a], xs[b]
        s.line([(xa, yy), (xb + (-4 if xb > xa else 4), yy)], dash="5 3" if ret else None,
               color=BLUE if not ret else DGREY, head="ahb" if not ret else "ah")
        s.text((xa + xb) / 2, yy - 6, text, 12.5, fill="#1b1b1b")
        y[0] += 38

    def self_msg(a, text):
        yy = y[0] - 10
        xa = xs[a]
        s.line([(xa, yy), (xa + 30, yy), (xa + 30, yy + 14), (xa + 4, yy + 14)], color=BLUE, head="ahb")
        s.text(xa + 38, yy + 11, text, 12.5, fill="#1b1b1b", anchor="start")
        y[0] += 34
    msg(0, 1, "1. open ticket")
    msg(1, 5, "2. latestVersion(tenantId, ticketId)")
    msg(5, 6, "3. tenant-scoped SELECT")
    msg(6, 5, "rows", ret=True)
    msg(1, 2, "4. deliberateTicket(version)")
    self_msg(2, "5. render + neutralize delimiters")
    msg(2, 3, "6. system prompt + <ticket> block")
    msg(3, 2, "strict JSON: candidate flags", ret=True)
    self_msg(2, "7. zod validate, dedupe, verify spans")
    msg(2, 4, "8. ticket + <candidates>")
    msg(4, 2, "keep / prune verdicts", ret=True)
    self_msg(2, "9. apply safety rules")
    msg(2, 1, "flags + call log", ret=True)
    msg(1, 5, "10. recordAnalysis(tenantId, ...)")
    msg(5, 6, "11. INSERT rows")
    msg(1, 0, "12. open flags", ret=True)
    return s.render()


def er():
    s = Svg(430)
    xs, ys = (8, 265, 522), (6, 92, 178, 264, 350)
    names = [["projects", "tenants", "memberships"], ["tickets", "ticket_versions", "readiness_events"],
             ["analysis_runs", "flags", "flag_decisions"], ["llm_calls", "labeling_sessions", "reviewer_gaps"],
             ["spec_compile_runs", "scenarios", "test_scaffolds"]]
    E = {n: (xs[c], ys[r]) for r, row in enumerate(names) for c, n in enumerate(row)}
    keys = {
        "tenants": "PK id", "memberships": "PK (user_id, tenant_id)", "projects": "FK tenant_id",
        "tickets": "FK project_id", "ticket_versions": "FK ticket_id", "readiness_events": "FK ticket_version_id",
        "analysis_runs": "FK ticket_version_id", "flags": "FK analysis_run_id", "flag_decisions": "FK flag_id",
        "llm_calls": "FK analysis/compile run", "labeling_sessions": "FK ticket_version_id",
        "reviewer_gaps": "FK labeling_session_id", "spec_compile_runs": "FK ticket_version_id",
        "scenarios": "FK compile_run_id", "test_scaffolds": "FK scenario_id",
    }
    bw, bh = 190, 54
    for n, (x, y) in E.items():
        s.add(f'<rect x="{x}" y="{y}" width="{bw}" height="{bh}" fill="white" stroke="{BLUE}" stroke-width="1.4"/>')
        s.add(f'<rect x="{x}" y="{y}" width="{bw}" height="24" fill="{NAVY}"/>')
        s.text(x + bw / 2, y + 17.5, n, 14.5, "bold", "white")
        s.text(x + bw / 2, y + 44, keys[n], 13.5, fill=DGREY)

    def c(n, side):
        x, y = E[n]
        return {"l": (x, y + bh / 2), "r": (x + bw, y + bh / 2), "t": (x + bw / 2, y), "b": (x + bw / 2, y + bh)}[side]

    def rel(a, sa, b, sb, la="1", lb="N"):
        p1, p2 = c(a, sa), c(b, sb)
        s.line([p1, p2], arrow=False, color=BLUE, width=1.3)
        def off(p, q):
            dx, dy = q[0] - p[0], q[1] - p[1]
            L = max((dx * dx + dy * dy) ** 0.5, 1)
            return (p[0] + dx / L * 14 + (6 if abs(dy) > abs(dx) else 0), p[1] + dy / L * 14 - (0 if abs(dy) > abs(dx) else 5))
        if p1[0] == p2[0]:
            top, bot = (p1, p2) if p1[1] < p2[1] else (p2, p1)
            lt, lbm = (la, lb) if top is p1 else (lb, la)
            s.text(top[0] - 6, top[1] + 15, lt, 14, "bold", DORANGE, "end")
            s.text(bot[0] + 6, bot[1] - 4, lbm, 14, "bold", DORANGE, "start")
            return
        o1, o2 = off(p1, p2), off(p2, p1)
        s.text(o1[0], o1[1] + 4, la, 14, "bold", DORANGE, "start")
        s.text(o2[0], o2[1] + 4, lb, 14, "bold", DORANGE, "start")
    rel("tenants", "r", "memberships", "l")
    rel("tenants", "l", "projects", "r")
    rel("projects", "b", "tickets", "t")
    rel("tickets", "r", "ticket_versions", "l")
    rel("ticket_versions", "r", "readiness_events", "l")
    rel("ticket_versions", "b", "flags", "t")
    rel("tickets", "b", "analysis_runs", "t")
    rel("analysis_runs", "r", "flags", "l")
    rel("flags", "r", "flag_decisions", "l")
    rel("analysis_runs", "b", "llm_calls", "t")
    rel("ticket_versions", "b", "labeling_sessions", "t")
    rel("labeling_sessions", "r", "reviewer_gaps", "l")
    rel("spec_compile_runs", "r", "scenarios", "l")
    rel("scenarios", "r", "test_scaffolds", "l")
    rel("spec_compile_runs", "t", "llm_calls", "b")
    return s.render()


def pipeline():
    s = Svg(470)
    steps = [
        (10, 20, ["Ticket version", "title, description, AC"], GREY, DGREY),
        (190, 20, ["Render & neutralize", "<ticket> delimiters,", "token ceiling"], LBLUE, BLUE),
        (370, 20, ["Pass 1: Extractor", "LLM, strict JSON", "schema output"], ORANGE, DORANGE),
        (550, 20, ["Validate", "zod parse, dedupe,", "verify quoted_span"], LBLUE, BLUE),
        (550, 170, ["Pass 2: Critic", "same model; keep or", "prune each candidate"], ORANGE, DORANGE),
        (370, 170, ["Safety rules", "unreviewed ⇒ keep;", "category/span locked"], LBLUE, BLUE),
        (190, 170, ["Persist", "flags (open / pruned),", "analysis_run, llm_calls"], PURPLE, DPURPLE),
        (10, 170, ["Review queue", "only open flags", "reach the PM"], GREEN, DGREEN),
    ]
    for x, y, ln, f, st in steps:
        s.box(x, y, 160, 90, ln, fill=f, stroke=st, size=12.5)
    for a, b in [((170, 65), (190, 65)), ((350, 65), (370, 65)), ((530, 65), (550, 65)), ((630, 110), (630, 170)),
                 ((550, 215), (530, 215)), ((370, 215), (350, 215)), ((190, 215), (170, 215))]:
        s.line([a, b], width=2)
    s.box(10, 300, 700, 150, (), fill="#FBFCFE", stroke=BLUE, rx=8, dash="6 4")
    s.text(360, 325, "Human review gate (no auto-resolve path)", 14, "bold", NAVY)
    gate = [(30, ["Accept", "question is valid"]), (200, ["Edit", "rewrite question"]),
            (370, ["Dismiss", "noise, recorded"]), (540, ["Reopen", "undo a decision"])]
    for x, ln in gate:
        s.box(x, 345, 150, 60, ln, fill=GREEN, stroke=DGREEN, size=12.5)
    s.text(360, 432, "Every decision is appended to flag_decisions (audit trail); 'Mark ready' is enabled only at 0 open flags.",
           12, fill=DGREY, style="italic")
    s.line([(90, 260), (90, 300)], width=2)
    return s.render()


def control():
    s = Svg(330)
    s.box(10, 20, 170, 80, ["Candidate flags", "N from Extractor", "(reviewer-judged)"], fill=GREY, stroke=DGREY, size=12.5)
    s.box(250, 0, 210, 80, ["Critic arm", "prunes k flags", "precision = Pc"], fill=ORANGE, stroke=DORANGE, size=12.5)
    s.box(250, 110, 210, 80, ["Random control", "prune the same k at random,", "1000 seeded permutations"], fill=LBLUE, stroke=BLUE, size=12)
    s.line([(180, 50), (250, 40)], width=1.8)
    s.line([(180, 70), (250, 150)], width=1.8)
    # histogram
    hx, hy = 520, 30
    bars = [2, 5, 11, 19, 26, 22, 14, 7, 3, 1]
    for i, v in enumerate(bars):
        s.add(f'<rect x="{hx + i * 17}" y="{hy + 140 - v * 4.6}" width="15" height="{v * 4.6}" fill="#9db8d6"/>')
    s.line([(hx - 4, hy + 140), (hx + 178, hy + 140)], arrow=False, color=DGREY)
    s.add(f'<line x1="{hx + 152}" y1="{hy + 10}" x2="{hx + 152}" y2="{hy + 145}" stroke="{DORANGE}" stroke-width="2.4"/>')
    s.text(hx + 152, hy + 4, "Pc", 12, "bold", DORANGE)
    s.text(hx + 88, hy + 160, "precision of random prunes", 11.5, fill=DGREY)
    s.line([(460, 150), (515, 120)], width=1.8)
    s.line([(460, 40), (668, 40)], width=1.8)
    s.box(100, 225, 520, 90, ["Decision rule (packages/eval/src/control.ts)",
                             "p = share of random prunes with precision ≥ Pc;  Critic kept only if p < 0.05",
                             "and zero reviewer gaps are lost to pruning. buildReport() throws if the control is missing."],
          fill=GREEN, stroke=DGREEN, size=12.5)
    s.line([(600, 200), (600, 225)], width=1.8)
    return s.render()


def compiler():
    s = Svg(400)
    row1 = [
        (10, ["Approved version", "all flags resolved,", "marked ready"], GREY, DGREY),
        (190, ["Spec Compiler", "compile-gherkin-v1", "LLM → JSON scenarios"], ORANGE, DORANGE),
        (370, ["Validate", "zod schema; covers_ac", "quote verified vs AC"], LBLUE, BLUE),
        (550, ["Human gate 1", "approve / edit /", "dismiss scenario"], GREEN, DGREEN),
    ]
    row2 = [
        (550, ["Scaffold emitter", "deterministic codegen,", "no LLM call"], LBLUE, BLUE),
        (370, ["Human gate 2", "fill PLACEHOLDER_*", "selectors, accept"], GREEN, DGREEN),
        (190, ["Traceability", "requirement → scenario", "→ scaffold links"], PURPLE, DPURPLE),
        (10, ["Coverage & drift", "pgvector cosine", "similarity views"], PURPLE, DPURPLE),
    ]
    for x, ln, f, st in row1:
        s.box(x, 20, 160, 90, ln, fill=f, stroke=st, size=12.5)
    for x, ln, f, st in row2:
        s.box(x, 180, 160, 90, ln, fill=f, stroke=st, size=12.5)
    for a in [170, 350, 530]:
        s.line([(a, 65), (a + 20, 65)], width=2)
    s.line([(630, 110), (630, 180)], width=2)
    for a in [550, 370, 190]:
        s.line([(a, 225), (a - 20, 225)], width=2)
    s.box(10, 300, 700, 85, (), fill="#FBFCFE", stroke=DGREY, rx=8, dash="6 4")
    s.text(360, 324, "Version pinning and drift", 13.5, "bold", NAVY)
    s.text(360, 347, "Scenarios and scaffolds belong to a ticket_version. When the ticket text changes, they turn 'stale'", 12, fill="#1b1b1b")
    s.text(360, 366, "and the drift panel pairs each previously-approved scenario with the closest clause of the new version.", 12, fill="#1b1b1b")
    return s.render()


def flag_states():
    s = Svg(330)
    st = {
        "start": (40, 150),
        "open": (190, 150), "accepted": (420, 40), "edited": (420, 150), "dismissed": (420, 260),
        "stale": (640, 150), "pruned": (190, 290),
    }
    s.add(f'<circle cx="40" cy="150" r="10" fill="{NAVY}"/>')
    for n, (x, y) in list(st.items())[1:]:
        fill = {"open": LBLUE, "pruned": ORANGE, "stale": GREY}.get(n, GREEN)
        stroke = {"open": BLUE, "pruned": DORANGE, "stale": DGREY}.get(n, DGREEN)
        s.box(x - 60, y - 22, 120, 44, [n], fill=fill, stroke=stroke, rx=20, size=14)
    s.line([(50, 150), (130, 150)]); s.label(90, 140, "Extractor", 11)
    s.line([(190, 172), (190, 268)]); s.label(195, 225, "Critic: prune", 11, anchor="start")
    s.line([(250, 140), (360, 50)]); s.label(290, 80, "accept", 11)
    s.line([(250, 150), (360, 150)]); s.label(305, 142, "edit", 11)
    s.line([(250, 160), (360, 250)]); s.label(318, 196, "dismiss", 11)
    s.line([(360, 60), (240, 172)], dash="5 3"); s.line([(360, 270), (225, 172)], dash="5 3")
    s.label(330, 112, "reopen", 11, fill=DPURPLE)
    s.line([(480, 40), (640, 40), (640, 128)]); s.line([(480, 150), (580, 150)]); s.line([(480, 260), (640, 260), (640, 172)])
    s.label(590, 30, "new ticket version", 11)
    s.text(360, 322, "Pruned flags are stored for audit and the random-pruning control, but never shown to a reviewer.", 11.5, fill=DGREY, style="italic")
    return s.render()


def labeling():
    s = Svg(230)
    stages = [("blind_gaps", ["1. blind_gaps", "reviewer writes", "own gap list"]),
              ("reveal", ["2. reveal", "model flags shown", "only after lock"]),
              ("link", ["3. link", "match each gap to", "a covering flag"]),
              ("done", ["4. done", "precision & recall", "counts available"])]
    for i, (k, ln) in enumerate(stages):
        x = 10 + i * 180
        s.box(x, 30, 160, 90, ln, fill=LBLUE if i < 3 else GREEN, stroke=BLUE if i < 3 else DGREEN, size=12.5)
        if i < 3:
            s.line([(x + 160, 75), (x + 180, 75)], width=2)
    s.label(180, 20, "lockGaps() sets gaps_locked_at", 11)
    s.box(10, 150, 700, 66, ["Why blind-first?", "If the reviewer saw the model's flags first, their gap list would be anchored to them and",
                             "recall would be meaningless. The server (not the UI) refuses to reveal flags before the lock."],
          fill="#FBFCFE", stroke=DGREY, size=12, dash="6 4")
    return s.render()


def embeddings():
    s = Svg(300)
    s.box(10, 15, 170, 64, ["AC clauses", "splitAcClauses()"], fill=GREY, stroke=DGREY, size=12.5)
    s.box(10, 130, 170, 64, ["Accepted scenarios", "gherkin_raw text"], fill=GREY, stroke=DGREY, size=12.5)
    s.box(240, 64, 190, 80, ["text-embedding-3-small", "1536-d vectors,", "batches of 96"], fill=ORANGE, stroke=DORANGE, size=12.5)
    s.cylinder(490, 54, 220, 100, ["pgvector (HNSW)", "requirement_clause_", "embeddings, scenario_", "embeddings"], fill=PURPLE, stroke=DPURPLE, size=12)
    s.line([(180, 47), (240, 85)]); s.line([(180, 162), (240, 124)])
    s.line([(430, 104), (490, 104)])
    s.box(180, 225, 530, 60, ["cosine similarity = 1 − (a <=> b)",
                             "clauseCoverage(): best scenario per clause  ·  driftedScenarios(): best clause per stale scenario"],
          fill=GREEN, stroke=DGREEN, size=12)
    s.line([(600, 154), (600, 225)])
    return s.render()


def packages_graph():
    s = Svg(300)
    P = {"web": (280, 10, ["apps/web", "Next.js dashboard"]),
         "eval": (20, 10, ["@specfix/eval", "CLI + metrics"]),
         "ops": (540, 10, ["scripts/ops.ts", "provision, seed, compile"]),
         "core": (90, 120, ["@specfix/core", "analysis, embeddings"]),
         "compiler": (300, 120, ["@specfix/compiler", "Gherkin + scaffold"]),
         "db": (510, 120, ["@specfix/db", "repositories, migrations"]),
         "ingest": (20, 225, ["@specfix/ingest", "FileSource"]),
         "shared": (300, 225, ["@specfix/shared", "zod schemas, types"])}
    for k, (x, y, ln) in P.items():
        s.box(x, y, 165 if k != "ops" else 170, 56, ln, fill=NAVY if k == "shared" else LBLUE,
              stroke=BLUE, size=12.5, tcolor="white" if k == "shared" else "#1b1b1b")
    def c(k, dx=0.5, dy=0.0):
        x, y, _ = P[k]; return (x + 165 * dx, y + 56 * dy)
    for a, b in [(c("web", 0.3, 1), c("core", 0.6, 0)), (c("web", 0.5, 1), c("compiler", 0.5, 0)), (c("web", 0.8, 1), c("db", 0.3, 0)),
                 (c("eval", 0.5, 1), c("core", 0.3, 0)), (c("ops", 0.5, 1), c("db", 0.6, 0)), (c("ops", 0.2, 1), c("compiler", 0.8, 0)),
                 (c("core", 0.6, 1), c("shared", 0.2, 0)), (c("compiler", 0.5, 1), c("shared", 0.5, 0)), (c("db", 0.3, 1), c("shared", 0.8, 0)),
                 (c("ingest", 1, 0.5), c("shared", 0, 0.5)), (c("eval", 0.2, 1), c("ingest", 0.3, 0))]:
        s.line([a, b], color=BLUE, head="ahb", width=1.4)
    s.text(600, 260, "arrow = 'imports'", 12, fill=DGREY, style="italic")
    return s.render()


# ---------------- UI layout wireframes (drawn from the page components) ----------------

def _browser(s, h, url):
    s.add(f'<rect x="5" y="5" width="710" height="{h - 10}" rx="8" fill="white" stroke="#9aa4b1" stroke-width="1.4"/>')
    s.add(f'<rect x="5" y="5" width="710" height="30" rx="8" fill="#EEF1F5"/>')
    for i, c in enumerate(["#ff6159", "#ffbd2e", "#28c941"]):
        s.add(f'<circle cx="{22 + i * 16}" cy="20" r="5" fill="{c}"/>')
    s.add(f'<rect x="80" y="11" width="560" height="18" rx="9" fill="white" stroke="#d0d6de"/>')
    s.text(92, 24, url, 11, fill=DGREY, anchor="start")
    s.add(f'<rect x="5" y="35" width="710" height="34" fill="{NAVY}"/>')
    s.text(20, 57, "SpecFix", 14, "bold", "white", "start")
    s.text(110, 57, "Acme Product Team  ▾", 12, fill="#d6e2f0", anchor="start")
    s.text(700, 57, "reviewer@acme.test  ·  Sign out", 11.5, fill="#d6e2f0", anchor="end")


def _badge(s, x, y, text, fill, color):
    w = len(text) * 6.4 + 16
    s.add(f'<rect x="{x - w}" y="{y}" width="{w}" height="20" rx="10" fill="{fill}"/>')
    s.text(x - w / 2, y + 14, text, 11, "bold", color)


def _btn(s, x, y, w, text, primary=True):
    s.add(f'<rect x="{x}" y="{y}" width="{w}" height="24" rx="5" fill="{NAVY if primary else "white"}" stroke="{NAVY}"/>')
    s.text(x + w / 2, y + 16, text, 11.5, "bold", "white" if primary else NAVY)


def ui_queue():
    s = Svg(400)
    _browser(s, 400, "localhost:3000/?project=…")
    s.text(30, 100, "Review queue", 19, "bold", "#111", "start")
    s.text(30, 120, "Tickets analyzed for ambiguity, waiting on a reviewer.", 12, fill=DGREY, anchor="start")
    for i, (p, on) in enumerate([("Payments", True), ("Platform API", False), ("Growth", False)]):
        x = 30 + i * 110
        s.add(f'<rect x="{x}" y="135" width="100" height="22" rx="11" fill="{NAVY if on else "white"}" stroke="#c7cfd9"/>')
        s.text(x + 50, 150, p, 11, "bold", "white" if on else DGREY)
    s.add('<rect x="30" y="170" width="660" height="215" rx="8" fill="white" stroke="#d5dbe3"/>')
    rows = [("PAY-142", "Allow partial refunds", "3 open flags", "#FFF3D6", "#8a5a00"),
            ("BILL-64", "Prorate charges when a plan changes mid-cycle", "Ready for dev", "#DFF3E4", DGREEN),
            ("CART-08", "Enforce a maximum quantity of 99 per line item", "Flags resolved", "#E3ECF8", BLUE),
            ("NOTIF-56", "Weekly digest email", "Not analyzed", "#EEF0F3", DGREY),
            ("RPT-19", "Export transactions to CSV", "1 open flag", "#FFF3D6", "#8a5a00")]
    for i, (k, t, b, f, c) in enumerate(rows):
        y = 170 + i * 43
        if i:
            s.add(f'<line x1="30" y1="{y}" x2="690" y2="{y}" stroke="#e6e9ee"/>')
        s.text(48, y + 18, k, 10.5, fill=DGREY, anchor="start")
        s.text(48, y + 34, t, 13, "bold", "#111", "start")
        _badge(s, 675, y + 12, b, f, c)
    return s.render()


def ui_ticket():
    s = Svg(560)
    _browser(s, 560, "localhost:3000/tickets/…")
    s.text(30, 96, "PAY-142  Allow partial refunds", 17, "bold", "#111", "start")
    s.text(30, 114, "Version captured 20 Oct · analysis: single-shot-v1 + critic-v1 · 2 open of 3", 11.5, fill=DGREY, anchor="start")
    s.add('<rect x="30" y="126" width="250" height="420" rx="8" fill="white" stroke="#d5dbe3"/>')
    s.text(45, 148, "Ticket", 13, "bold", "#111", "start")
    for i, ln in enumerate(["TITLE", "Allow partial refunds", "DESCRIPTION", "Support agents currently have", "to refund an entire order even",
                            "when only one item came back", "damaged…", "ACCEPTANCE CRITERIA", "• Agent can select an order",
                            "  and enter a refund amount", "• Agent can add a reason", "• The customer is notified",
                            "• The refund appears in the", "  order history"]):
        cap = ln.isupper()
        s.text(45, 172 + i * 19, ln, 10 if cap else 11.5, "bold" if cap else "normal", DGREY if cap else "#222", "start")
    # flags
    fl = [("Missing information", "high", "“enter a refund amount”",
           "Can a partial refund exceed the item's price, and", "is there a minimum amount?"),
          ("Vague language", "medium", "“quickly”",
           "What is the maximum acceptable delay before the", "refund appears on the customer's account?"),
          ("Security / compliance", "medium", "“tracked properly”",
           "Which audit fields must finance be able to see", "(agent, reason, timestamp, approver)?")]
    for i, (cat, sev, span, q1, q2) in enumerate(fl):
        y = 126 + i * 128
        s.add(f'<rect x="295" y="{y}" width="395" height="116" rx="8" fill="white" stroke="#d5dbe3"/>')
        s.text(310, y + 20, cat, 12.5, "bold", NAVY, "start")
        _badge(s, 680, y + 6, sev, "#FFE3E0" if sev == "high" else "#FFF3D6", "#9b2c20" if sev == "high" else "#8a5a00")
        s.text(310, y + 40, "quoted: " + span, 11, fill=DGREY, anchor="start", style="italic")
        s.text(310, y + 60, q1, 11.5, fill="#222", anchor="start")
        s.text(310, y + 76, q2, 11.5, fill="#222", anchor="start")
        if i < 2:
            _btn(s, 310, y + 84, 70, "Accept")
            _btn(s, 388, y + 84, 60, "Edit", False)
            _btn(s, 456, y + 84, 70, "Dismiss", False)
        else:
            _badge(s, 400, y + 86, "Accepted", "#DFF3E4", DGREEN)
            _btn(s, 410, y + 84, 70, "Reopen", False)
    s.add('<rect x="295" y="510" width="395" height="36" rx="8" fill="#F6F8FB" stroke="#d5dbe3"/>')
    s.text(310, 533, "Mark ready for development", 12, "bold", DGREY, "start")
    s.add(f'<rect x="560" y="516" width="118" height="24" rx="5" fill="#c4ccd6"/>')
    s.text(619, 532, "2 flags still open", 11, "bold", "white")
    return s.render()


def ui_specs():
    s = Svg(600)
    _browser(s, 600, "localhost:3000/tickets/…/specs")
    s.text(30, 96, "PAY-142  ·  Specs", 17, "bold", "#111", "start")
    for i, (t, on) in enumerate([("Review", False), ("Specs", True)]):
        s.text(560 + i * 70, 96, t, 13, "bold" if on else "normal", NAVY if on else DGREY)
        if on:
            s.add(f'<line x1="607" y1="102" x2="653" y2="102" stroke="{NAVY}" stroke-width="2.5"/>')
    s.add('<rect x="30" y="112" width="660" height="54" rx="8" fill="white" stroke="#d5dbe3"/>')
    s.text(45, 134, "Generate Gherkin scenarios", 13, "bold", "#111", "start")
    s.text(45, 153, "From the approved acceptance criteria and 3 resolved clarifications.", 11.5, fill=DGREY, anchor="start")
    _btn(s, 560, 127, 118, "Generate again")
    s.add('<rect x="30" y="176" width="420" height="250" rx="8" fill="white" stroke="#d5dbe3"/>')
    s.text(45, 198, "Scenario 1 of 4 — Agent issues a partial refund", 12.5, "bold", NAVY, "start")
    g = [("Given", "an order with two items totalling 1,200.00"), ("And", "the support agent has opened the order"),
         ("When", "the agent enters a refund amount of 400.00"), ("And", "the agent submits the refund"),
         ("Then", "the order history shows a refund of 400.00"), ("And", "the customer receives a confirmation email")]
    s.add('<rect x="45" y="208" width="390" height="140" rx="5" fill="#F6F8FB"/>')
    for i, (k, t) in enumerate(g):
        s.text(55, 228 + i * 21, k, 11.5, "bold", DPURPLE, "start")
        s.text(100, 228 + i * 21, t, 11.5, fill="#222", anchor="start")
    s.text(45, 370, "covers AC: “Agent can select an order and enter a refund amount”", 10.5, fill=DGREY, anchor="start", style="italic")
    _btn(s, 45, 388, 70, "Accept")
    _btn(s, 123, 388, 60, "Edit", False)
    _btn(s, 191, 388, 70, "Dismiss", False)
    s.add('<rect x="465" y="176" width="225" height="250" rx="8" fill="white" stroke="#d5dbe3"/>')
    s.text(480, 198, "Coverage", 13, "bold", "#111", "start")
    stats = [("AC clauses with a scenario", "4/4"), ("Resolved flags with a scenario", "3/3"), ("Scenarios with a scaffold", "2/4")]
    for i, (l, v) in enumerate(stats):
        s.text(480, 226 + i * 46, l, 10.5, fill=DGREY, anchor="start")
        s.text(480, 246 + i * 46, v, 17, "bold", NAVY, "start")
    s.text(480, 380, "Clause match (cosine)", 10.5, fill=DGREY, anchor="start")
    s.add(f'<rect x="480" y="388" width="190" height="10" rx="5" fill="#e6e9ee"/><rect x="480" y="388" width="160" height="10" rx="5" fill="{DGREEN}"/>')
    s.text(480, 414, "0.84 best match", 10.5, fill=DGREY, anchor="start")
    s.add('<rect x="30" y="436" width="660" height="150" rx="8" fill="white" stroke="#d5dbe3"/>')
    s.text(45, 458, "Playwright scaffold — placeholder selectors (human must fill)", 12.5, "bold", NAVY, "start")
    code = ["test.fixme('Agent issues a partial refund for one damaged item', async ({ page }) => {",
            "  await page.locator('PLACEHOLDER_2_THE_AGENT_ENTERS_A_REFUND_AMOUNT'); // TODO",
            "  await page.locator('PLACEHOLDER_3_THE_AGENT_SUBMITS_THE_REFUND');     // TODO"]
    s.add('<rect x="45" y="468" width="630" height="66" rx="5" fill="#1e2430"/>')
    for i, ln in enumerate(code):
        s.add(f'<text x="55" y="{488 + i * 18}" font-family="Consolas, monospace" font-size="10.5" fill="#d8e1ec">{ln.replace("<", "&lt;").replace("&", "&amp;") if False else ln.replace("&", "&amp;").replace("<", "&lt;")}</text>')
    _btn(s, 45, 548, 120, "Accept scaffold")
    _btn(s, 173, 548, 70, "Dismiss", False)
    _btn(s, 251, 548, 100, "Download", False)
    s.text(675, 565, "Drift: 0 approved specs on an older version", 11, fill=DGREY, anchor="end", style="italic")
    return s.render()


def ui_login():
    s = Svg(300)
    for k, (x, title, fields, btn) in enumerate([(20, "SpecFix", ["Email", "Password"], "Sign in"),
                                                  (370, "Create your workspace", ["Organisation name", "First project name"], "Create workspace")]):
        s.add(f'<rect x="{x}" y="10" width="330" height="280" rx="10" fill="#F6F8FB" stroke="#c7cfd9"/>')
        s.add(f'<rect x="{x + 30}" y="35" width="270" height="230" rx="8" fill="white" stroke="#d5dbe3"/>')
        s.text(x + 50, 68, title, 16, "bold", "#111", "start")
        s.text(x + 50, 88, "Sign in to review tickets" if k == 0 else "A tenant with you as owner", 11, fill=DGREY, anchor="start")
        for i, f in enumerate(fields):
            s.text(x + 50, 116 + i * 52, f, 11, "bold", DGREY, "start")
            s.add(f'<rect x="{x + 50}" y="{122 + i * 52}" width="230" height="24" rx="4" fill="white" stroke="#c7cfd9"/>')
        _btn(s, x + 50, 228, 230, btn)
    s.text(185, 286, "(a) Login page", 11.5, fill=DGREY, style="italic")
    s.text(535, 286, "(b) Onboarding page", 11.5, fill=DGREY, style="italic")
    return s.render()


def results_chart():
    """Bar chart of the committed generation-eval report with Wilson 95% intervals."""
    s = Svg(300)
    data = [("AC coverage", 0.9167, 0.8045, 0.9671, "44 / 48 clauses"),
            ("Hallucinated-cover rate", 0.0238, 0.0042, 0.1232, "1 / 42 scenarios"),
            ("Scaffold validity", 1.0, 0.9162, 1.0, "42 / 42 scaffolds")]
    x0, y0, wmax = 230, 40, 400
    for t in [0, 0.25, 0.5, 0.75, 1.0]:
        x = x0 + wmax * t
        s.add(f'<line x1="{x}" y1="{y0 - 10}" x2="{x}" y2="{y0 + 210}" stroke="#e3e7ec"/>')
        s.text(x, y0 + 228, f"{int(t * 100)}%", 11.5, fill=DGREY)
    for i, (name, v, lo, hi, note) in enumerate(data):
        y = y0 + i * 70
        s.text(x0 - 12, y + 26, name, 13, "bold", "#1b1b1b", "end")
        s.text(x0 - 12, y + 44, note, 11.5, fill=DGREY, anchor="end")
        col = DGREEN if i != 1 else DORANGE
        s.add(f'<rect x="{x0}" y="{y + 10}" width="{max(wmax * v, 2)}" height="34" rx="3" fill="{col}" opacity="0.85"/>')
        s.add(f'<line x1="{x0 + wmax * lo}" y1="{y + 27}" x2="{x0 + wmax * hi}" y2="{y + 27}" stroke="#111" stroke-width="1.6"/>')
        for xx in (lo, hi):
            s.add(f'<line x1="{x0 + wmax * xx}" y1="{y + 19}" x2="{x0 + wmax * xx}" y2="{y + 35}" stroke="#111" stroke-width="1.6"/>')
        tx = x0 + wmax * max(v, hi) + 10
        s.text(min(tx, 690), y + 32, f"{v * 100:.1f}%", 13, "bold", "#111", "start" if tx < 650 else "end")
    s.text(430, 292, "Bars: point estimate · whiskers: Wilson 95% interval · gold-v1, 11 tickets, gpt-5.4-mini, temperature 0",
           11, fill=DGREY, style="italic")
    return s.render()


def test_chart():
    s = Svg(330)
    rows = [("shared", 26, 0), ("ingest", 17, 0), ("core", 74, 2), ("compiler", 15, 1), ("eval", 89, 0), ("db", 49, 47)]
    x0, y0, scale = 165, 20, 4.2
    for t in range(0, 101, 20):
        x = x0 + t * scale
        s.add(f'<line x1="{x}" y1="{y0 - 6}" x2="{x}" y2="{y0 + 6 * 42}" stroke="#e3e7ec"/>')
        s.text(x, y0 + 6 * 42 + 18, str(t), 11.5, fill=DGREY)
    for i, (n, p, sk) in enumerate(rows):
        y = y0 + i * 42
        s.text(x0 - 12, y + 24, "@specfix/" + n, 12.5, "bold", "#1b1b1b", "end")
        s.add(f'<rect x="{x0}" y="{y + 8}" width="{p * scale}" height="24" fill="{DGREEN}"/>')
        if sk:
            s.add(f'<rect x="{x0 + p * scale}" y="{y + 8}" width="{sk * scale}" height="24" fill="#c9d1db"/>')
        s.text(x0 + (p + sk) * scale + 8, y + 25, f"{p} passed" + (f", {sk} skipped" if sk else ""), 11.5, fill="#1b1b1b", anchor="start")
    s.add(f'<rect x="200" y="{y0 + 6 * 42 + 30}" width="14" height="12" fill="{DGREEN}"/>')
    s.text(220, y0 + 6 * 42 + 40, "passed", 11.5, fill=DGREY, anchor="start")
    s.add(f'<rect x="290" y="{y0 + 6 * 42 + 30}" width="14" height="12" fill="#c9d1db"/>')
    s.text(310, y0 + 6 * 42 + 40, "skipped offline (needs a test database or a live model key)", 11.5, fill=DGREY, anchor="start")
    return s.render()


ALL = {
    "arch": architecture, "dfd0": dfd0, "dfd1": dfd1, "usecase": usecase, "class": classdiagram,
    "seq": sequence, "er": er, "pipeline": pipeline, "control": control, "compiler": compiler,
    "states": flag_states, "labeling": labeling, "embed": embeddings, "pkgs": packages_graph,
    "ui_login": ui_login, "ui_queue": ui_queue, "ui_ticket": ui_ticket, "ui_specs": ui_specs,
    "results": results_chart, "tests": test_chart,
}
