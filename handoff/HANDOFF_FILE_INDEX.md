# SpecFix Project Handoff Index

This directory contains the complete technical handoff package for continuing the development of **SpecFix** using Claude Pro.

---

## Recommended Reading Order

```
1. CLAUDE_START_HERE.md         <-- START HERE (Crucial instructions, rules, and initial task)
        │
        ▼
2. PROJECT_CONTEXT.md           (Full architectural model, end-to-end data flow, tech stack)
        │
        ▼
3. GIT_AND_DATABASE_STATE.md    (Verified Git working tree, commits, and database migration status)
        │
        ▼
4. IMPLEMENTATION_STATUS.md     (Detailed milestone completion matrix for Phase 0, 1, and 2)
        │
        ▼
5. KNOWN_ISSUES_AND_NEXT_STEPS.md (Actionable engineering backlog and technical task breakdown)
```

---

## Document Index & Descriptions

| Document | Purpose & Summary |
| :--- | :--- |
| **[CLAUDE_START_HERE.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/handoff/CLAUDE_START_HERE.md)** | **Primary Entry Point.** Contains explicit non-negotiable operating rules, core project invariants (human gates, tenant isolation, no secret exposure), the verified repository state, and step-by-step instructions for executing the first implementation task (embedding call logging & tests). |
| **[PROJECT_CONTEXT.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/handoff/PROJECT_CONTEXT.md)** | **System Architecture & Context.** Covers project purpose, intended users, end-to-end data flow, package structure, entity relationship models, database schemas, dual OpenAI/Azure integration, token cost tracking, and development commands. |
| **[GIT_AND_DATABASE_STATE.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/handoff/GIT_AND_DATABASE_STATE.md)** | **State of Truth.** Documents the current branch (`shrikant`), HEAD commit (`8a7a076`), staged files, unstaged performance optimizations, untracked embedding files, remote migration history (including migration `0004`), live table row counts, and independent verification commands. |
| **[IMPLEMENTATION_STATUS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/handoff/IMPLEMENTATION_STATUS.md)** | **Milestone Audit Matrix.** Evaluates Phase 0, Phase 1, and Phase 2 Milestones A–F against verified code and test evidence. Identifies what is Complete (A, B, C), Partially Complete (D, E), or Pending (F). |
| **[KNOWN_ISSUES_AND_NEXT_STEPS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/handoff/KNOWN_ISSUES_AND_NEXT_STEPS.md)** | **Engineering Backlog.** Details active technical bugs (unlogged embedding spend, Azure content moderation block on adversarial suite, `nearestRequirements` query semantics) and specifies an actionable, dependency-ordered five-task implementation plan. |

---

## Rules for Future Maintenance of this Directory

* **Do Not Overwrite Historical Findings:** When updating these documents after future milestones merge, append new findings or clearly mark updated sections with timestamps.
* **Never Commit Credentials:** Ensure no secrets or API keys are ever added to any document in this folder.
