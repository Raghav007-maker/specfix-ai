# MASTER PROJECT CONTEXT: SpecFix

Welcome to the **SpecFix** technical documentation package. This master document serves as the primary gateway for software engineers, repository auditors, and AI coding assistants.

---

## 1. Executive Summary

**SpecFix** is a software requirements disambiguation and specification quality platform. It operates as an automated pre-development quality gate that catches ambiguities, unaddressed edge cases, untestable criteria, and contradictions in product requirements before engineers begin coding.

* **Repository Architecture:** TypeScript monorepo using npm workspaces (`apps/web`, `packages/compiler`, `packages/core`, `packages/db`, `packages/shared`, `packages/ingest`, `packages/eval`).
* **Active Branch:** `shrikant` (HEAD commit `8a7a076` on Oct 13, 2026).
* **Current Phase:** Phase 2 (Specflow, Scenarios, and Traceability).
* **AI Providers:** Azure OpenAI Service (`gpt-5.4-mini` for structured chat, `text-embedding-3-small` for 1536-dim embeddings) with standard OpenAI fallback.
* **Database:** Supabase PostgreSQL with `pgvector` extension and Row-Level Security.

---

## 2. Directory Navigation & Reading Order

For an optimal understanding of the platform, read the generated reports in this sequence:

```
1. 00_EXECUTIVE_SUMMARY.md             Overview, architecture, current status, top findings
        │
        ▼
2. 01_PRODUCT_AND_REQUIREMENTS.md      Product vision, personas, business invariants, open questions
        │
        ▼
3. 02_ARCHITECTURE.md                  System diagrams, package boundaries, sequence flows
        │
        ▼
4. 03_CODEBASE_MAP.md                  Directory map, deep call chains, code smells
        │
        ▼
5. 04_DATABASE_AND_MIGRATIONS.md       Schema inventory, RLS, migration 0004 status, table counts
        │
        ▼
6. 06_AI_EMBEDDINGS_AND_LLM_LOGGING.md AI pipelines, prompt structure, embeddings, logging audit
        │
        ▼
7. 10_FEATURE_STATUS_MATRIX.md         Verification status of all features and milestones
        │
        ▼
8. 11_FINDINGS_AND_RISKS.md            Prioritized findings, defects, and risks register
        │
        ▼
9. 12_ROADMAP_AND_NEXT_STEPS.md        Engineering backlog and implementation tasks
        │
        ▼
10. 13_AI_CONTEXT_AND_WORKING_RULES.md Crucial operating rules for continuing development
```

---

## 3. Quick Reference: Documentation Index

| Report | Title & Focus | Primary Audience |
| :--- | :--- | :--- |
| **[00_EXECUTIVE_SUMMARY.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/00_EXECUTIVE_SUMMARY.md)** | Executive Overview & Architecture | Leadership & Engineers |
| **[01_PRODUCT_AND_REQUIREMENTS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/01_PRODUCT_AND_REQUIREMENTS.md)** | Problem Statement & Business Invariants | Product Managers & Engineers |
| **[02_ARCHITECTURE.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/02_ARCHITECTURE.md)** | System Diagrams & Package Boundaries | Software Architects |
| **[03_CODEBASE_MAP.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/03_CODEBASE_MAP.md)** | File Inventory & Execution Call Chains | Developers |
| **[04_DATABASE_AND_MIGRATIONS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/04_DATABASE_AND_MIGRATIONS.md)** | Database Schema, RLS & Migration 0004 | Database Engineers |
| **[05_APIS_AND_INTEGRATIONS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/05_APIS_AND_INTEGRATIONS.md)** | Server Actions, Package APIs & CLI Tools | Full-Stack Engineers |
| **[06_AI_EMBEDDINGS_AND_LLM_LOGGING.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/06_AI_EMBEDDINGS_AND_LLM_LOGGING.md)** | AI Prompts, pgvector Embeddings & Logging | AI & Machine Learning Engineers |
| **[07_TESTING_AND_QUALITY.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/07_TESTING_AND_QUALITY.md)** | Vitest Suite, DB Guardrails & Gaps | QA Engineers & SDETs |
| **[08_SECURITY_AND_RELIABILITY.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/08_SECURITY_AND_RELIABILITY.md)** | Tenant Isolation, SQL/Prompt Injection & Pooler | Security & Reliability Engineers |
| **[09_ENVIRONMENT_AND_DEPLOYMENT.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/09_ENVIRONMENT_AND_DEPLOYMENT.md)** | Environment Variables, Setup & CI/CD | DevOps & Infrastructure |
| **[10_FEATURE_STATUS_MATRIX.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/10_FEATURE_STATUS_MATRIX.md)** | Verification Matrix across All Milestones | Project Managers & Leads |
| **[11_FINDINGS_AND_RISKS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/11_FINDINGS_AND_RISKS.md)** | Prioritized Technical Defects & Risks Register | Architects & Leads |
| **[12_ROADMAP_AND_NEXT_STEPS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/12_ROADMAP_AND_NEXT_STEPS.md)** | Actionable Engineering Backlog (P0–P4) | Engineering Leads |
| **[13_AI_CONTEXT_AND_WORKING_RULES.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/13_AI_CONTEXT_AND_WORKING_RULES.md)** | Instructions & Safe Working Guidelines for AI | AI Assistants |
| **[14_SOURCE_OF_TRUTH_AND_OPEN_QUESTIONS.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/14_SOURCE_OF_TRUTH_AND_OPEN_QUESTIONS.md)** | Documentation Conflicts & Owner Questions | Product Owner |
| **[15_INVESTIGATION_LOG.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/15_INVESTIGATION_LOG.md)** | Audit Steps, Executed Commands & Evidence | Auditors |

---

## 4. Current Development Position & Recommended First Task

The codebase is poised at the completion of **Phase 2 Milestone D (Traceability & Embeddings)**. The immediate next engineering task is:

> **Task P0-1: Implement Embedding Call Logging & Unit Tests**
> 1. Add `recordEmbeddingCalls` to `packages/db/src/repositories/embeddings.ts` to log embedding spend in `llm_calls`.
> 2. Call `recordEmbeddingCalls` in `packages/db/scripts/embed-backfill.ts`.
> 3. Add offline unit tests in `packages/core/test/embeddings.test.ts`.

Refer to **[13_AI_CONTEXT_AND_WORKING_RULES.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/docs/project-handoff/13_AI_CONTEXT_AND_WORKING_RULES.md)** for detailed implementation guidelines.
