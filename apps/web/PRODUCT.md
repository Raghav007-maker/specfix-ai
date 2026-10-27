# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the product manager.** A PM on an ordinary software team that writes requirements as
Jira tickets. Before a ticket goes to development, they open SpecFix to see what the model found
ambiguous or missing, decide on every surviving flag (accept, edit, dismiss), and sign the ticket
off as ready for development.

**Secondary: QA and engineering leads.** They review what Phase 2 generates from PM-approved
criteria: Gherkin scenarios and Playwright scaffolds. They approve, edit, or dismiss each
scenario and fill in real selectors where the scaffold leaves placeholders.

The landing page addresses "product and QA teams who review tickets before sprint planning."

Workspace roles: `owner` and `admin` manage members and roles on the Team page; `reviewer`
reviews but cannot create projects.

## Product Purpose

Ambiguous or incomplete tickets get filled in with developer assumptions. The result passes unit
tests but misses business intent, and the gap surfaces late, in QA or after release, when it is
most expensive to fix. SpecFix catches those gaps at the ticket stage: a ticket goes in,
structured flags come out, a human resolves each one, and the ticket is marked ready for
development. The disambiguated acceptance criteria then feed Gherkin scenarios and test
scaffolds.

Success means flags a PM treats as real issues rather than noise, and fewer questions per ticket
once development starts. The plan also tracks time-to-ready per ticket.

## Positioning

A lightweight, Jira-native requirements check, built and priced for ordinary software teams
rather than regulated-industry systems engineering (the space of tools like QVscribe and IBM's
Requirements Quality Assistant).

What it does differently:
- **Blind first.** The reviewer writes and locks their own gap list before seeing any model flag.
  SpecFix then links the two, so the model's work is measured against a human's, not the
  reverse.
- An Adversarial Critic pass removes false alarms before a reviewer sees them.
- Every AI-generated artifact sits behind a human decision. Nothing auto-resolves.
- It writes to Jira exactly once, at PM sign-off.

## Operating Context

- **Source of tickets:** Jira (title, description, acceptance criteria), pulled on demand or by
  webhook. The repo also ingests from files.
- **Flow:** review queue → ticket → lock the blind gap list → Review tab (flags) → PM sign-off →
  Specs tab (scenarios and scaffolds) → download scaffold. An optional Conversation tab resolves
  flags one at a time with an agent instead of the form.
- **Organization:** a workspace holds projects; projects hold tickets and their review history.
  A user can belong to more than one workspace and switch between them.
- **Measurement:** an Analytics page shows review status, per-project breakdown, open findings,
  decision outcomes, time to ready, weekly activity, and form-vs-conversation measures. The eval
  harness scores flag precision and recall against gold sets and tests the Critic arm against a
  random-pruning control.

## Capabilities and Constraints

**Capabilities**
- Public landing page for signed-out visitors; the review queue for signed-in users.
- Ticket ingestion, LLM ambiguity analysis, and the Adversarial Critic pass.
- Review dashboard: per-flag accept / edit / dismiss / reopen, with an audit trail.
- Single Jira write-back at sign-off.
- Phase 2: Gherkin scenario generation, deterministic Playwright scaffolds, and a
  requirement → scenario → test traceability graph.
- Conversational resolution agent, behind `SPECFIX_RESOLUTION_AGENT=on`: it asks about one open
  flag at a time and drafts a decision. Nothing changes until the reviewer applies the draft. It
  is an alternative to the form, measured against it, not a replacement.
- Team page and Analytics page.

**Terminology**
- *Flag categories:* missing info, vague language, contradiction, edge case,
  security/compliance, untestable.
- *Severity:* low / medium / high.
- *Flag states:* open, accepted, edited, dismissed, stale (ticket changed after resolution),
  pruned (removed by the Critic, kept for audit, never shown to the reviewer).
- *Scenario states:* draft, approved, edited, dismissed, stale.
- *Queue statuses:* Not analyzed, N open flags, Flags resolved, No flags, Ready for dev.

**Constraints**
- A human decides every flag and every generated scenario. There is no auto-resolve path, and
  the UI must never imply one.
- No flag is read and no model call is made before the reviewer's gap list is locked.
- Generated scaffolds use placeholder selectors only. A person fills in the real ones.
- Ticket text is data, never instructions.
- Critic-arm precision is never shown without its control comparison and p-value.
- Out of scope (Phase 3+): PR-vs-spec verification, merge gating, Confluence and doc auto-sync,
  autonomous or multi-agent workflows, non-English tickets, attachments and images.

## Brand Commitments

- The name is **SpecFix**.
- The SF mark: an S and an F drawn with one stroke weight and slanted together
  (`components/brand.tsx`).

## Evidence on Hand

- Sample and adversarial tickets in `fixtures/tickets/` are test material, not customer data.
- The landing page's rate-limiting ticket and its flags are an illustrative demo, not a customer
  case.
- No real customers, design partners, testimonials, logos, pricing, or quotable metrics.
  Committed eval reports in `fixtures/eval-runs/` are not cleared to cite as product evidence.
  Future work must not fabricate any of these.

## Product Principles

1. **The human decides.** The model proposes and filters. A person resolves, approves, and signs
   off, and the interface makes that ownership obvious.
2. **Signal over volume.** A flag the PM dismisses as noise costs trust. Fewer, sharper flags beat
   exhaustive ones.
3. **Honest numbers.** Never present a metric without the context that makes it meaningful.
4. **The ticket is the record.** It reflects what was agreed at sign-off. SpecFix does not keep
   rewriting it to match the code.
5. **Built for ordinary teams.** Lightweight, fast, and fitting the PM's existing Jira workflow
   rather than an enterprise systems-engineering process.
