# Unleash the Agents: Cross-Review MCP Broker Analysis

**Date**: 2026-04-01  
**Agents consulted**: 40 of 69 registered agents across 4 waves  
**Convergence achieved**: Yes — top 3 families exceed 3x null model  
**Adversarial pass**: Completed (advocatus-diaboli, Wave 3)

---

## Executive Summary

40 domain-specialist agents independently analyzed the cross-review-mcp broker (~566 lines, 2 source files). They converged on a central finding: **the system's theoretical foundation (QSG scaling laws) is misapplied in ways that make the quality guarantee decorative rather than operative**. The minimum bandwidth constraint m >= 3 places the system exactly at the drift-selection boundary (Gamma_h = 1.0), not safely in the selection regime. The QSG parameters (h ~ 0.05, alpha ~ 0.3) are assumed constants, not measured quantities, and the system collects no telemetry that would allow their empirical validation. The system is empirically unfalsifiable by design.

Beyond the theoretical issues, multiple concrete engineering flaws were identified: the phase protocol is unsound (agents can complete without exchanging anything), the `discuss` verdict connects to no resolution mechanism, the destructive poll creates unrecoverable message loss, and same-model agents violate the epistemic independence assumption the QSG framework requires.

---

## Ranked Hypothesis Families

### #1: Gamma_h = 1.0 is critical boundary, not selection regime

**Convergence**: 13 agents (markovian, diffusion-specialist, theoretical-researcher, number-theorist, physicist, geometrist, swarm-strategist, adaptic, senior-software-developer, senior-researcher, senior-data-scientist, gxp-validator, hildegard)  
**Null model**: 4.8x expected (SIGNIFICANT)

**Finding**: The comment in `types.ts:119` derives "m > 3" (strict inequality) but `MIN_BANDWIDTH = 3` (non-strict). With m=3, N=2, h=0.05, alpha=0.3: Gamma_h = 3 x 2 x 0.05 / 0.3 = **1.0 exactly**. The selection regime requires |Gamma_h| >> 1. The system sits at the phase transition boundary where outcome variance is maximized.

**Sub-findings**:
- (number-theorist) h/alpha = 1/6 = 1/|FindingCategory| — the parameters are structurally coupled to the 6-category taxonomy
- (geometrist) m=3 is the geometric minimum for a review distribution to reach the interior of a 2-face of the finding 5-simplex
- (diffusion-specialist) At Gamma_h = 1.0, the coefficient of variation of session quality is maximized — some sessions will be selection-driven, others drift-driven, and the operator cannot distinguish which
- (theoretical-researcher) The mean-field derivation underlying QSG is invalid for N=2; the paper validated on N >= 8

**Adversarial counter** (advocatus-diaboli): h may be larger for external review (unfamiliarity increases detection), pushing true Gamma_h to 2-3. Valid but the parameters are unmeasured.

**Testable prediction**: Set MIN_BANDWIDTH to 1, 3, and 6 across 30+ sessions each. If Gamma_h matters, finding acceptance rates should differ significantly. If they don't, the QSG constraint is not operative.

---

### #2: System is empirically unfalsifiable — no telemetry, parameters unverifiable

**Convergence**: 10 agents (senior-software-developer, senior-data-scientist, mlops-engineer, auditor, gxp-validator, senior-researcher, contemplative, version-manager, adaptic, polymath)  
**Null model**: 3.7x expected (SIGNIFICANT)

**Finding**: The verdict field in `FindingResponse` is the only ground-truth quality proxy in the entire system. `poll_tasks` destroys it on read (`state.taskQueues.set(agentId, [])` at server.ts:210). No logging, no metrics, no session records persist. The QSG parameters h and alpha cannot be estimated from zero observations.

**Key framing** (auditor): "The system's quality claim is structurally self-consuming — evidence exists only during transit."

**Sub-findings**:
- (mlops) Verdict outcomes are the one measurable proxy for alpha (adaptation rate): `alpha_empirical ~ 1 - reject_rate`. This data is discarded.
- (data-scientist) Estimating h requires ground-truth injection (known-correct and known-incorrect findings). No harness exists.
- (senior-researcher) The system has no outcome measure, no baseline condition (m < 3), and no stopping rule — it is a prototype with theoretical clothing.

**Testable prediction**: Add append-only JSONL logging of all `FindingResponse` verdicts. After 20+ sessions, compute per-category accept rates. If alpha varies by more than 2x across sessions, the fixed MIN_BANDWIDTH = 3 is inadequate.

---

### #3: LLM epistemic independence not guaranteed by temporal ordering

**Convergence**: 8 agents (adaptic, swarm-strategist, theoretical-researcher, physicist, diffusion-specialist, contemplative, nlp-specialist, polymath)  
**Null model**: 3.0x expected (AT THRESHOLD)

**Finding**: QSG assumes agents' biases h are independent. Two instances of the same model share training distribution, architecture, and RLHF feedback signal. The briefing-first phase ordering ensures agents don't read each other's output (temporal independence), but cannot ensure their priors are uncorrelated (epistemic independence). Temporal independence != epistemic independence.

**NLP-specific mechanisms** (nlp-specialist):
- **Autoregressive entrainment**: Within a single bundle generation, each finding's text is conditioned on prior findings, creating linguistic correlation
- **Briefing-to-finding semantic leakage**: Reviewers paraphrase the peer's `knownIssues` rather than discovering new problems
- **Enum position bias**: RLHF-trained models disproportionately select early enum values (`pattern_transfer`, `missing_practice`)

**Adversarial counter** (advocatus-diaboli): Independence is contextual (different codebases provide different contexts), not just parametric (different weights). Cross-review inherently provides some diversity. **Concession**: N=2 homogeneity risk from shared weights cannot be fixed by bandwidth alone.

**Testable prediction**: Run both agents on the same test codebase. Measure semantic similarity (embedding cosine distance) of independently generated finding sets. Compare against findings from a Claude + GPT-4 pair. Same-model findings should show significantly higher correlation.

---

### #4: Phase protocol is unsound — no semantic preconditions

**Convergence**: 7 agents (logician, senior-software-developer, code-reviewer, markovian, acp-developer, project-manager, gxp-validator)

**Finding**: An agent can reach `complete` without exchanging any artifacts. `signal_phase` only enforces monotonicity (target > current), not that the agent performed the phase's semantic work. The `wait_for_phase` constraint is advisory (documented in protocol resource), not enforced in code.

**Concrete proof** (logician): The following sequence succeeds with zero meaningful work:
```
register("A", "project", ["review"])
signal_phase("A", "briefing")    // no briefing sent
signal_phase("A", "review")     // no review bundle sent
signal_phase("A", "dialogue")   // no wait_for_phase called
signal_phase("A", "complete")   // no findings responded to
```

**Sub-finding** (project-manager): No quorum check — a single agent can complete the entire session without a peer. The `send_task` sender inference heuristic means an agent can even send tasks to itself.

**Testable prediction**: Write a single-client test that registers one agent, advances through all phases, and reaches `complete`. It will pass.

---

### #5: Destructive poll creates at-most-once delivery and dead states

**Convergence**: 7 agents (senior-software-developer, code-reviewer, markovian, acp-developer, security-analyst, auditor, alchemist)

**Finding**: `poll_tasks` atomically drains the queue with no acknowledgment mechanism. If processing fails after the drain, messages are permanently lost. Combined with monotonic phases, this creates absorbing "zombie" states from which completion is impossible without external intervention.

**Markov chain framing** (markovian): The system has additional absorbing states beyond `(complete, complete)` — any state where a required message was drained but the agent crashed. These are "dead transient states" from which the probability of reaching the intended absorbing state is zero.

---

### #6: `discuss` verdict is structurally orphaned

**Convergence**: 4 agents (shapeshifter, hildegard, shaman, contemplative)

**Finding**: The `discuss` verdict is supposed to "create a sub-task for focused exchange," but nothing prevents an agent from signaling `complete` before discussion resolves. The Question/Response task types exist, but phase enforcement has no gate checking for pending discussions.

**Metaphors converge across domains**:
- shapeshifter: "Chrysalis with a false exit — imaginal discs present but prevented from differentiating"
- hildegard: "Dialogue without fire — the warming element that allows earth to become fertile"
- shaman: "Journey without integration — the return is incomplete"

**Testable prediction**: In any session with `discuss` verdicts, the peer's queue will contain unanswered `question` tasks at the moment `complete` is signaled.

---

### #7: Bandwidth constraint applied to wrong phase edge

**Convergence**: 3 agents (alchemist, physicist, polymath)

**Finding**: MIN_BANDWIDTH enforced only on `review_bundle` (outbound findings), not on `response` (inbound verdicts). The dialogue phase — where belief updating actually happens — operates with no bandwidth constraint. An agent can respond to 3 findings with a 1-item FindingResponse[].

**Code evidence**: server.ts:150: `if (type === "review_bundle")` — no corresponding branch for `type === "response"`.

---

### #8: Finding taxonomy is not MECE

**Convergence**: 3 agents (librarian, number-theorist, geometrist)

**Finding**: The 6 categories mix observation types (`inconsistency`, `simplification`) with severity/consequence types (`bug_risk`). `missing_practice` overlaps with all others. No architectural-level category exists — the `targetFile`/`targetLines` schema forces file-local scoping. System-level findings (coupling, missing abstractions) are unrepresentable.

---

### #9: Missing integration/synthesis phase

**Convergence**: 3 agents (shaman, hildegard, contemplative)

**Finding**: No post-dialogue step where both agents synthesize accepted findings into a shared artifact. Each agent updates independently. No convergent shared knowledge is produced. Second-order patterns (things A noticed about B that rhyme with things B noticed about A) are structurally undiscoverable.

---

### #10: Nash equilibrium of minimum-effort bundles

**Convergence**: 2 agents (polymath, contemplative)

**Finding**: A bundle of 3 `documentation_gap` findings (System 1, shallow, low-effort) satisfies every protocol constraint. The Nash equilibrium under cognitive effort minimization is structurally valid but epistemically shallow reviews. The QSG formula cannot distinguish high-h deep expertise from high-h shallow pattern fluency.

---

## Adversarial Pass Summary

The advocatus-diaboli (Wave 3) challenged the top consensus and made three valid counterarguments:

1. **h is directional and asymmetric**: An external reviewer may have higher h (stronger bias toward correct findings) because unfamiliarity removes normalization blindness. If h = 0.1-0.15, then Gamma_h = 2-3, firmly in selection. **Status**: Valid but unfalsifiable — h is unmeasured.

2. **N=2 eliminates pair-selection variance**: The stochastic concern from QSG (which pair communicates?) is structurally absent at N=2. **Status**: Valid narrowly but does not address drift magnitude.

3. **Gamma_h = 1.0 is crossover, not drift**: The consensus overstated "outcomes are a coin flip." At Gamma_h = 1.0, the system is strictly better than no bandwidth constraint (Gamma_h < 1). **Status**: Valid — the consensus conflated "not safely in selection" with "no better than chance."

**Surviving finding**: N=2 homogeneity risk from shared model weights cannot be fixed by bandwidth. The devil's advocate conceded this explicitly: "the correct fix is not larger m but larger N with model diversity."

---

## Null Model Verification

With K ~ 15 plausible hypothesis families and N = 40 agents:
- Random convergence per family: ~40/15 = 2.7 agents
- 3x threshold: 8.1 agents

| Family | Agents | Ratio | Significant? |
|--------|--------|-------|-------------|
| #1 Gamma_h boundary | 13 | 4.8x | YES |
| #2 Unfalsifiable | 10 | 3.7x | YES |
| #3 Epistemic independence | 8 | 3.0x | THRESHOLD |
| #4 Unsound protocol | 7 | 2.6x | Borderline (but code-proven) |
| #5 Destructive poll | 7 | 2.6x | Borderline (but code-proven) |
| #6-10 | 2-4 | <2x | Below threshold individually |

Families 1-2 clearly exceed the null model. Family 3 is at threshold. Families 4-5 are borderline statistically but have direct code evidence proving the hypothesis (the logician's concrete execution path for #4 is independently verifiable).

---

## Top-Level Synthesis

The 40-agent sweep reveals a system with a **competent engineering skeleton** (clean types, sound phase ordering concept, well-structured MCP integration) wrapped around a **decorative theoretical framework** (QSG parameters that are assumed, not measured; a bandwidth constraint that hits the boundary, not the interior of the selection regime; no telemetry to validate any of it).

The three highest-confidence actionable improvements, in priority order:

1. **Add verdict logging** (Families #2, #7): Append-only JSONL sidecar recording every FindingResponse with session ID, timestamps, finding category, and verdict. This is the minimum instrumentation to make the system's quality claims empirically testable. ~20 lines of code.

2. **Raise MIN_BANDWIDTH to 5** (Family #1): This pushes Gamma_h from 1.0 to 1.67, safely above the boundary. The geometric analysis (Family #8) shows m=5 enables coverage of 4-faces of the finding simplex. The number-theorist's h/alpha = 1/6 coupling confirms m=5 gives Gamma_h = 5/3 > 1.

3. **Add phase precondition checks** (Families #4, #6): Gate `signal_phase("review")` on having sent a briefing. Gate `signal_phase("complete")` on having no pending `question` tasks. ~30 lines of code. This transforms the phase machine from monotonic-counter to verified-state-machine.

The deeper architectural question — whether N=2 same-model cross-review produces genuine epistemic value or is "a single model reviewing itself through a mirror with a JSON envelope" (contemplative) — cannot be resolved by engineering improvements alone. It requires empirical measurement with the telemetry from improvement #1.

---

## Validation Checklist

- [x] 40/69 agents consulted (convergence achieved; remaining 29 are domain specialists unlikely to produce new families)
- [x] Responses collected in structured format (hypothesis/reasoning/confidence/prediction)
- [x] Hypotheses deduplicated into 10 families, ranked by convergence count
- [x] Top 3 families verified against null model (4.8x, 3.7x, 3.0x vs 2.7 expected)
- [x] Adversarial pass challenged consensus (3 valid counterarguments, 1 surviving finding)
- [x] Final hypotheses include testable predictions and known limitations
